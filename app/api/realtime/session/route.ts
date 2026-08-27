const OPENAI_CLIENT_SECRET_URL =
  "https://api.openai.com/v1/realtime/translations/client_secrets";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-live-transcribe";

type TargetLanguage = "ja" | "en";

function isTargetLanguage(value: unknown): value is TargetLanguage {
  return value === "ja" || value === "en";
}
export async function GET() {
  return Response.json({ configured: Boolean(process.env.OPENAI_API_KEY) });
}

export async function POST(request: Request) {
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

  let body: { targetLanguage?: unknown };
  try {
    body = (await request.json()) as { targetLanguage?: unknown };
  } catch {
    return Response.json({ error: "JSON body is required." }, { status: 400 });
  }

  if (!isTargetLanguage(body.targetLanguage)) {
    return Response.json(
      { error: "targetLanguage must be either ja or en." },
      { status: 400 },
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
        model: "gpt-realtime-translate",
        audio: {
          input: {
            transcription: { model: transcriptionModel },
            noise_reduction: { type: "far_field" },
          },
          output: { language: body.targetLanguage },
        },
      },
    }),
  });

  const payload = await upstream.text();
  return new Response(payload, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
  });
}
