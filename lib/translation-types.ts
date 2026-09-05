export type Language = "ja" | "en";
export type TargetLanguage = Language;

export type Utterance = {
  id: string;
  sequence: number;
  at: string;
  sourceLanguage: Language | "unknown";
  sourceText?: string;
  startMs?: number;
  endMs?: number;
  speechEndMs?: number;
  sourceStatus?: "pending" | "streaming" | "completed";
  status?: "draft" | "final";
  ja: string;
  en: string;
};
