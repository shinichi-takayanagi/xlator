export type TargetLanguage = "ja" | "en";

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
};

type ConnectOptions = {
  targetLanguage: TargetLanguage;
  sourceStream: MediaStream;
  muted: boolean;
  onEvent: (targetLanguage: TargetLanguage, event: TranslationEvent) => void;
  onConnectionState: (targetLanguage: TargetLanguage, state: RTCPeerConnectionState) => void;
};

type ClientSecretResponse = {
  value?: string;
  error?: string | { message?: string };
};

function getErrorMessage(payload: ClientSecretResponse, fallback: string) {
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message ?? fallback;
}

async function createClientSecret(targetLanguage: TargetLanguage) {
  const response = await fetch("/api/realtime/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage }),
  });
  const payload = (await response.json()) as ClientSecretResponse;

  if (!response.ok || !payload.value) {
    throw new Error(getErrorMessage(payload, "Realtimeセッションを作成できませんでした。"));
  }

  return payload.value;
}

export async function connectTranslation({
  targetLanguage,
  sourceStream,
  muted,
  onEvent,
  onConnectionState,
}: ConnectOptions): Promise<TranslationConnection> {
  const sourceTrack = sourceStream.getAudioTracks()[0];
  if (!sourceTrack) throw new Error("マイクの音声トラックが見つかりません。");

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
  events.onmessage = ({ data }) => {
    try {
      onEvent(targetLanguage, JSON.parse(String(data)) as TranslationEvent);
    } catch {
      // Ignore malformed or unknown data channel messages.
    }
  };

  const clientSecretPromise = createClientSecret(targetLanguage);
  const localOfferPromise = (async () => {
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
    const answerResponse = await fetch(
      "https://api.openai.com/v1/realtime/translations/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offerSdp,
      },
    );

    if (!answerResponse.ok) {
      throw new Error((await answerResponse.text()) || "WebRTC接続に失敗しました。");
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await answerResponse.text(),
    });
  } catch (error) {
    translatedAudio.pause();
    translatedAudio.srcObject = null;
    events.close();
    peerConnection.close();
    throw error;
  }

  return {
    targetLanguage,
    audio: translatedAudio,
    close: () => {
      if (events.readyState === "open") {
        events.send(JSON.stringify({ type: "session.close" }));
      }
      translatedAudio.pause();
      translatedAudio.srcObject = null;
      events.close();
      peerConnection.close();
    },
  };
}
