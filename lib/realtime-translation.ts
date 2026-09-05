import type { TargetLanguage } from "./translation-types";
import {
  abortError,
  createConnectionAbortScope,
  waitForDataChannel,
  waitForPeerConnection,
  withAbort,
} from "./realtime-connection";

export type { TargetLanguage } from "./translation-types";

export type TranslationEvent = {
  type: string;
  delta?: string;
  elapsed_ms?: number | null;
  error?: { message?: string };
};

export type TranslationConnection = {
  targetLanguage: TargetLanguage;
  audio: HTMLAudioElement;
  close: () => void;
  drain: (timeoutMs: number) => Promise<void>;
};

type ConnectOptions = {
  targetLanguage: TargetLanguage;
  sourceStream: MediaStream;
  muted: boolean;
  signal?: AbortSignal;
  onEvent: (targetLanguage: TargetLanguage, event: TranslationEvent) => void;
  onConnectionState: (targetLanguage: TargetLanguage, state: RTCPeerConnectionState) => void;
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
const cachedClientSecrets = new Map<TargetLanguage, CachedClientSecret>();
const pendingClientSecrets = new Map<TargetLanguage, Promise<string>>();

function getErrorMessage(payload: ClientSecretResponse, fallback: string) {
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message ?? fallback;
}

async function fetchClientSecret(targetLanguage: TargetLanguage) {
  const response = await fetch("/api/realtime/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage }),
  });
  const payload = (await response.json()) as ClientSecretResponse;

  if (!response.ok || !payload.value) {
    throw new Error(getErrorMessage(payload, "Realtimeセッションを作成できませんでした。"));
  }

  return {
    value: payload.value,
    expiresAt: payload.expires_at ?? 0,
  };
}

async function getClientSecret(targetLanguage: TargetLanguage) {
  const cached = cachedClientSecrets.get(targetLanguage);
  if (
    cached &&
    cached.expiresAt * 1_000 - Date.now() > CLIENT_SECRET_EXPIRY_SKEW_MS
  ) {
    return cached.value;
  }

  const pending = pendingClientSecrets.get(targetLanguage);
  if (pending) return pending;

  const request = fetchClientSecret(targetLanguage)
    .then((secret) => {
      if (
        secret.expiresAt * 1_000 - Date.now() > CLIENT_SECRET_EXPIRY_SKEW_MS
      ) {
        cachedClientSecrets.set(targetLanguage, secret);
      }
      return secret.value;
    })
    .finally(() => pendingClientSecrets.delete(targetLanguage));
  pendingClientSecrets.set(targetLanguage, request);
  return request;
}

export async function prefetchTranslationClientSecrets() {
  await Promise.all(
    (["en", "ja"] as const).map((targetLanguage) => getClientSecret(targetLanguage)),
  );
}

export async function connectTranslation({
  targetLanguage,
  sourceStream,
  muted,
  signal,
  onEvent,
  onConnectionState,
}: ConnectOptions): Promise<TranslationConnection> {
  if (signal?.aborted) throw abortError(signal);
  const sourceTrack = sourceStream.getAudioTracks()[0];
  if (!sourceTrack) throw new Error("マイクの音声トラックが見つかりません。");

  const abortScope = createConnectionAbortScope(signal, signal ? null : undefined);
  const connectionSignal = abortScope.signal;

  const peerConnection = new RTCPeerConnection();
  peerConnection.addTrack(sourceTrack, sourceStream);

  const translatedAudio = new Audio();
  translatedAudio.autoplay = true;
  translatedAudio.muted = muted;
  peerConnection.ontrack = ({ streams }) => {
    translatedAudio.srcObject = streams[0];
  };
  peerConnection.onconnectionstatechange = () => {
    onConnectionState(targetLanguage, peerConnection.connectionState);
  };

  const events = peerConnection.createDataChannel("oai-events");
  let closed = false;
  let drainPromise: Promise<void> | null = null;
  let resolveDrain: (() => void) | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    connectionSignal.removeEventListener("abort", close);
    abortScope.dispose();
    if (drainTimer !== null) clearTimeout(drainTimer);
    drainTimer = null;
    resolveDrain?.();
    resolveDrain = null;
    translatedAudio.pause();
    translatedAudio.srcObject = null;
    events.close();
    peerConnection.close();
  };
  events.onmessage = ({ data }) => {
    if (closed) return;
    try {
      const event = JSON.parse(String(data)) as TranslationEvent;
      onEvent(targetLanguage, event);
      if (event.type === "session.closed") close();
    } catch {
      // Ignore malformed or unknown data channel messages.
    }
  };
  events.addEventListener("close", close, { once: true });
  connectionSignal.addEventListener("abort", close, { once: true });

  const drain = (timeoutMs: number): Promise<void> => {
    if (drainPromise) return drainPromise;
    if (closed) return Promise.resolve();
    drainPromise = new Promise<void>((resolve) => { resolveDrain = resolve; });
    drainTimer = setTimeout(close, timeoutMs);
    try {
      if (events.readyState !== "open") close();
      else events.send(JSON.stringify({ type: "session.close" }));
    } catch {
      close();
    }
    return drainPromise;
  };

  const clientSecretPromise = withAbort(getClientSecret(targetLanguage), connectionSignal);
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
    const answerResponse = await fetch(
      "https://api.openai.com/v1/realtime/translations/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offerSdp,
        signal: connectionSignal,
      },
    );

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
    targetLanguage,
    audio: translatedAudio,
    close,
    drain,
  };
}
