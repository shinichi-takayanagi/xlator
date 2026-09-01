import {
  createResponsesTranslationBody,
  createResponseTextDeltaStream,
  DEFAULT_TEXT_TRANSLATION_MODEL,
  parseTextTranslationInput,
} from "../../../lib/text-translation.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error: "OPENAI_API_KEY が設定されていません。",
        code: "missing_api_key",
      },
      { status: 503 },
    );
  }

  let input;
  try {
    input = parseTextTranslationInput(await request.json());
  } catch {
    return Response.json({ error: "JSON body is required." }, { status: 400 });
  }
  if (!input) {
    return Response.json(
      { error: "A non-empty ja/en translation request is required." },
      { status: 400 },
    );
  }

  const model =
    process.env.OPENAI_TEXT_TRANSLATION_MODEL?.trim() ||
    DEFAULT_TEXT_TRANSLATION_MODEL;
  const upstream = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "xlator-local-user",
    },
    body: JSON.stringify(createResponsesTranslationBody(input, model)),
    signal: request.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const message = await upstream.text();
    return Response.json(
      { error: message || "Text translation failed." },
      { status: upstream.status || 502 },
    );
  }

  return new Response(createResponseTextDeltaStream(upstream.body), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
