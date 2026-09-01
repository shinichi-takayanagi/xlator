import type { Language } from "./translation-types";

type StreamTextTranslationOptions = {
  text: string;
  sourceLanguage: Language;
  targetLanguage: Language;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
};

export async function streamTextTranslation({
  text,
  sourceLanguage,
  targetLanguage,
  signal,
  onDelta,
}: StreamTextTranslationOptions) {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, sourceLanguage, targetLanguage }),
    signal,
  });

  if (!response.ok || !response.body) {
    let message = "テキスト翻訳に失敗しました。";
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Keep the user-facing fallback for non-JSON errors.
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const delta = decoder.decode(value, { stream: true });
    if (delta) onDelta(delta);
  }
  const tail = decoder.decode();
  if (tail) onDelta(tail);
}
