const OPENAI_CLIENT_SECRET_URL =
  "https://api.openai.com/v1/realtime/client_secrets";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
const DEFAULT_TRANSCRIPTION_DELAY = "minimal";
const TRANSCRIPTION_DELAYS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function getTranscriptionDelay() {
  const configured = process.env.OPENAI_TRANSCRIPTION_DELAY?.trim();
  return configured && TRANSCRIPTION_DELAYS.has(configured)
    ? configured
    : DEFAULT_TRANSCRIPTION_DELAY;
}

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY;
  const transcriptionModel =
    process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL;

  if (!apiKey) {
    return Response.json(
      {
        error: "OPENAI_API_KEY が設定されていません。",
        code: "missing_api_key",
      },
      { status: 503 },
    );
  }

  const upstream = await fetch(OPENAI_CLIENT_SECRET_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "xlator-local-user",
    },
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: 600,
      },
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: {
              model: transcriptionModel,
              languages: ["en", "ja"],
              delay: getTranscriptionDelay(),
            },
            noise_reduction: { type: "far_field" },
          },
        },
      },
    }),
  });

  const payload = await upstream.text();
  return new Response(payload, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
    },
  });
}
