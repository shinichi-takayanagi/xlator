import { createClientSecretResponse } from "../../../../lib/realtime-client-secret.ts";

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

function getTranscriptionContext(): { prompt?: string; keywords?: string[] } {
  const prompt = process.env.OPENAI_TRANSCRIPTION_PROMPT?.trim();
  const configuredKeywords = process.env.OPENAI_TRANSCRIPTION_KEYWORDS?.trim();
  if (!configuredKeywords) return prompt ? { prompt } : {};

  const parsed: unknown = JSON.parse(configuredKeywords);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((keyword): keyword is string => (
      typeof keyword === "string" &&
      keyword.trim().length > 0 &&
      !/[<>\r\n]/u.test(keyword)
    ))
  ) {
    throw new Error("Invalid transcription keywords");
  }
  const keywords = [...new Set(parsed.map((keyword) => keyword.trim()))];
  return {
    ...(prompt ? { prompt } : {}),
    ...(keywords.length ? { keywords } : {}),
  };
}

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
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

  let context: ReturnType<typeof getTranscriptionContext>;
  try {
    context = getTranscriptionContext();
  } catch {
    return Response.json(
      {
        error: "OPENAI_TRANSCRIPTION_KEYWORDS は空でない文字列のJSON配列にしてください。各用語に改行や < > は使用できません。",
        code: "invalid_transcription_context",
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
              ...context,
            },
            noise_reduction: { type: "far_field" },
            turn_detection: null,
          },
        },
      },
    }),
  });

  return createClientSecretResponse(upstream);
}
