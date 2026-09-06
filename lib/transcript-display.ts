import type { Language, Utterance } from "./translation-types";

export type TranscriptKind = "source" | "translation";
export type TranscriptCommit = {
  rowId: string;
  sequence: number;
  kind: TranscriptKind;
  language: Language;
  sourceFinal: boolean;
};

export function getTranscriptDisplay(row: Utterance, language: Language) {
  const unknown = row.sourceLanguage === "unknown";
  // Use one explicitly unclassified source slot, keeping both language fields empty.
  const pendingSource = unknown && language === "ja" && Boolean(row.sourceText?.trim());
  const text = unknown ? (pendingSource ? row.sourceText! : "") : row[language];
  const kind: TranscriptKind | null = unknown
    ? pendingSource ? "source" : null
    : row.sourceLanguage === language ? "source" : "translation";
  const sourceFinal = row.sourceLanguageStatus === "final";
  const provisional = row.sourceLanguageStatus === "provisional";
  const label = unknown
    ? pendingSource
      ? sourceFinal ? "原文・言語不明" : "原文・言語判定中"
      : sourceFinal ? "言語不明" : "処理中"
    : `${kind === "source" ? "原文" : "翻訳"}${provisional ? "・暫定" : ""}`;
  return { text, kind, label, sourceFinal, textLanguage: unknown ? undefined : language };
}

export function hasSameTranscriptDisplay(a: Utterance, b: Utterance, language: Language) {
  if (a === b) return true;
  if (a.id !== b.id || a.sequence !== b.sequence || a.at !== b.at ||
      a.status !== b.status || a.sourceLanguage !== b.sourceLanguage) return false;
  const first = getTranscriptDisplay(a, language);
  const second = getTranscriptDisplay(b, language);
  return first.text === second.text && first.label === second.label &&
    first.sourceFinal === second.sourceFinal;
}
