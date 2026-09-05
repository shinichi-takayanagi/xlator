import {
  abortError,
  createConnectionAbortScope,
  waitForDataChannel,
  waitForPeerConnection,
  withAbort,
} from "./realtime-connection";

export type TranscriptionEvent = {
  type: string;
  item_id?: string;
  audio_start_ms?: number;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
};

export type TranscriptionConnection = {
  close: () => void;
  clear: () => boolean;
  commit: () => boolean;
};

type ConnectOptions = {
  sourceStream: MediaStream;
  signal?: AbortSignal;
  onEvent: (event: TranscriptionEvent) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
};

type ClientSecretResponse = {
  value?: string;
  expires_at?: number;
  error?: string | { message?: string };
};

type CachedClientSecret = {
  value: string;
  expiresAt: number;
};

const CLIENT_SECRET_EXPIRY_SKEW_MS = 5_000;
let cachedClientSecret: CachedClientSecret | null = null;
let pendingClientSecret: Promise<string> | null = null;

function getErrorMessage(payload: ClientSecretResponse, fallback: string) {
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message ?? fallback;
}

async function fetchClientSecret() {
  const response = await fetch("/api/realtime/transcription", { method: "POST" });
  const payload = (await response.json()) as ClientSecretResponse;

  if (!response.ok || !payload.value) {
    throw new Error(getErrorMessage(payload, "文字起こしセッションを作成できませんでした。"));
  }

  return {
    value: payload.value,
    expiresAt: payload.expires_at ?? 0,
  };
}

async function getClientSecret() {
  if (
    cachedClientSecret &&
    cachedClientSecret.expiresAt * 1_000 - Date.now() > CLIENT_SECRET_EXPIRY_SKEW_MS
  ) {
    return cachedClientSecret.value;
  }

  if (pendingClientSecret) return pendingClientSecret;

  pendingClientSecret = fetchClientSecret()
    .then((secret) => {
      if (
        secret.expiresAt * 1_000 - Date.now() > CLIENT_SECRET_EXPIRY_SKEW_MS
      ) {
        cachedClientSecret = secret;
      }
      return secret.value;
    })
    .finally(() => {
      pendingClientSecret = null;
    });
  return pendingClientSecret;
}

export async function prefetchTranscriptionClientSecret() {
  await getClientSecret();
}

export async function connectTranscription({
  sourceStream,
  signal,
  onEvent,
  onConnectionState,
}: ConnectOptions): Promise<TranscriptionConnection> {
  if (signal?.aborted) throw abortError(signal);
  const sourceTrack = sourceStream.getAudioTracks()[0];
  if (!sourceTrack) throw new Error("マイクの音声トラックが見つかりません。");

  const abortScope = createConnectionAbortScope(signal, signal ? null : undefined);
  const connectionSignal = abortScope.signal;
  const peerConnection = new RTCPeerConnection();
  peerConnection.addTrack(sourceTrack, sourceStream);
  peerConnection.onconnectionstatechange = () => {
    onConnectionState(peerConnection.connectionState);
  };

  const events = peerConnection.createDataChannel("oai-events");
  events.onmessage = ({ data }) => {
    try {
      const event = JSON.parse(String(data)) as TranscriptionEvent;
      onEvent(event);
    } catch {
      // Ignore malformed or unknown data channel messages.
    }
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    connectionSignal.removeEventListener("abort", close);
    abortScope.dispose();
    events.close();
    peerConnection.close();
  };
  connectionSignal.addEventListener("abort", close, { once: true });

  const clientSecretPromise = withAbort(getClientSecret(), connectionSignal);
  const localOfferPromise = withAbort(
    (async () => {
      if (connectionSignal.aborted) throw abortError(connectionSignal);
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      if (!offer.sdp) throw new Error("WebRTC offerを作成できませんでした。");
      return offer.sdp;
    })(),
    connectionSignal,
  );

  try {
    const [clientSecret, offerSdp] = await Promise.all([
      clientSecretPromise,
      localOfferPromise,
    ]);
    const answerResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offerSdp,
      signal: connectionSignal,
    });

    if (!answerResponse.ok) {
      throw new Error((await answerResponse.text()) || "WebRTC接続に失敗しました。");
    }

    const answerSdp = await withAbort(answerResponse.text(), connectionSignal);
    await withAbort(
      peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp }),
      connectionSignal,
    );
    await Promise.all([
      waitForPeerConnection(peerConnection, connectionSignal, null),
      waitForDataChannel(events, connectionSignal, null),
    ]);
    abortScope.clearDeadline();
  } catch (error) {
    close();
    throw error;
  }

  return {
    close,
    clear() {
      if (closed || events.readyState !== "open") return false;
      try {
        events.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        return true;
      } catch {
        return false;
      }
    },
    commit() {
      if (closed || events.readyState !== "open") return false;
      try {
        events.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
