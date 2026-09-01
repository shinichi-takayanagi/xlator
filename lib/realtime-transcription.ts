import {
  createConnectionAbortScope,
  waitForPeerConnection,
  withAbort,
} from "./realtime-translation";

export type TranscriptionEvent = {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
};

export type TranscriptionConnection = {
  close: () => void;
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

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("接続がキャンセルされました。", "AbortError");
}

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

  const abortScope = createConnectionAbortScope(signal);
  const connectionSignal = abortScope.signal;
  const peerConnection = new RTCPeerConnection();
  peerConnection.addTrack(sourceTrack, sourceStream);
  peerConnection.onconnectionstatechange = () => {
    onConnectionState(peerConnection.connectionState);
  };

  const events = peerConnection.createDataChannel("oai-events");
  events.onmessage = ({ data }) => {
    try {
      onEvent(JSON.parse(String(data)) as TranscriptionEvent);
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
  const localOfferPromise = (async () => {
    if (connectionSignal.aborted) throw abortError(connectionSignal);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    if (!offer.sdp) throw new Error("WebRTC offerを作成できませんでした。");
    return offer.sdp;
  })();

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

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await answerResponse.text(),
    });
    await waitForPeerConnection(peerConnection, connectionSignal);
    abortScope.clearDeadline();
  } catch (error) {
    close();
    throw error;
  }

  return { close };
}
