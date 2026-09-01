import type { Language } from "./translation-types";

export const DEFAULT_TEXT_TRANSLATION_MODEL = "gpt-5.6-luna";
export const MAX_TRANSLATION_INPUT_LENGTH = 5_000;

export type TextTranslationInput = {
  text: string;
  sourceLanguage: Language;
  targetLanguage: Language;
};

const LANGUAGE_NAMES: Record<Language, string> = {
  ja: "Japanese",
  en: "English",
};

export function parseTextTranslationInput(value: unknown): TextTranslationInput | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.text !== "string" ||
    !body.text.trim() ||
    body.text.length > MAX_TRANSLATION_INPUT_LENGTH ||
    (body.sourceLanguage !== "ja" && body.sourceLanguage !== "en") ||
    (body.targetLanguage !== "ja" && body.targetLanguage !== "en") ||
    body.sourceLanguage === body.targetLanguage
  ) {
    return null;
  }

  return {
    text: body.text,
    sourceLanguage: body.sourceLanguage,
    targetLanguage: body.targetLanguage,
  };
}

export function createResponsesTranslationBody(
  input: TextTranslationInput,
  model = DEFAULT_TEXT_TRANSLATION_MODEL,
) {
  return {
    model,
    stream: true,
    store: false,
    reasoning: { effort: "none" },
    max_output_tokens: 256,
    instructions: [
      "You are a live Japanese-English translator.",
      `Translate the input from ${LANGUAGE_NAMES[input.sourceLanguage]} to ${LANGUAGE_NAMES[input.targetLanguage]}.`,
      "Output only the translation, without explanations or labels.",
      "Translate idiomatically using the full conversational context.",
      "Preserve names, numbers, tone, and sentence-ending punctuation when natural.",
      "Interpret common phrases in context; for example, 'fine today' usually describes good weather.",
    ].join(" "),
    input: input.text,
  };
}

export function createResponseTextDeltaStream(
  upstream: ReadableStream<Uint8Array>,
) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const processEvent = (block: string, controller: ReadableStreamDefaultController) => {
    for (const line of block.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trimStart();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as {
        type?: string;
        delta?: string;
        message?: string;
        error?: { message?: string };
      };
      if (event.type === "response.output_text.delta" && event.delta) {
        controller.enqueue(encoder.encode(event.delta));
      } else if (event.type === "error") {
        throw new Error(event.error?.message ?? event.message ?? "Text translation failed.");
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) processEvent(buffer, controller);
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.search(/\r?\n\r?\n/u);
          while (boundary >= 0) {
            const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] ?? "\n\n";
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + separator.length);
            processEvent(block, controller);
            boundary = buffer.search(/\r?\n\r?\n/u);
          }
        }
      } catch (error) {
        controller.error(error);
        void reader.cancel(error).catch(() => undefined);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
