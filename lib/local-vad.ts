export const COMPLETE_UTTERANCE_SILENCE_MS = 320;
export const DEFAULT_UTTERANCE_SILENCE_MS = 450;
export const NO_TRANSCRIPT_FINALIZE_MS = 1_200;
export const SPEECH_CONFIRMATION_MS = 120;

const TERMINAL_PUNCTUATION = /[。.!！？?…]["'”’）)\]」』]*$/u;

export function getVadSilenceDurationMs(sourceText: string) {
  return TERMINAL_PUNCTUATION.test(sourceText.trim())
    ? COMPLETE_UTTERANCE_SILENCE_MS
    : DEFAULT_UTTERANCE_SILENCE_MS;
}
