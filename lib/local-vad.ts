export const COMPLETE_UTTERANCE_SILENCE_MS = 320;
export const DEFAULT_UTTERANCE_SILENCE_MS = 450;

const TERMINAL_PUNCTUATION = /[。.!！？?…]["'”’）)\]」』]*$/u;

export function getVadSilenceDurationMs(sourceText: string) {
  return TERMINAL_PUNCTUATION.test(sourceText.trim())
    ? COMPLETE_UTTERANCE_SILENCE_MS
    : DEFAULT_UTTERANCE_SILENCE_MS;
}
