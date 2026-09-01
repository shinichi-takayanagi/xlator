import type { TargetLanguage, Utterance } from "./translation-types";

export type TranslationCandidates = Partial<Record<TargetLanguage, string>>;

export function createLiveUtterance(
  sequence: number,
  elapsedMs: number,
  id = `live-${Date.now()}-${sequence}`,
): Utterance {
  const seconds = Math.floor(elapsedMs / 1_000);
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return {
    id,
    sequence,
    at: `${minutes}:${remainder}`,
    startMs: elapsedMs,
    endMs: elapsedMs,
    sourceLanguage: "unknown",
    sourceText: "",
    ja: "",
    en: "",
    status: "draft",
  };
}

export function detectLanguage(text: string): TargetLanguage | "unknown" {
  if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(text)) return "ja";
  if (/[A-Za-z]/.test(text)) return "en";
  return "unknown";
}

export function findLastRowStartingAtOrBefore(
  rows: Utterance[],
  elapsedMs: number,
  endExclusive = rows.length,
) {
  for (let index = Math.min(endExclusive, rows.length) - 1; index >= 0; index -= 1) {
    if ((rows[index].startMs ?? 0) <= elapsedMs) return index;
  }

  return -1;
}

export function appendTranslationCandidate(
  candidates: TranslationCandidates,
  targetLanguage: TargetLanguage,
  delta: string,
): TranslationCandidates {
  return {
    ...candidates,
    [targetLanguage]: `${candidates[targetLanguage] ?? ""}${delta}`,
  };
}

export function alignSourceAndTranslation(
  row: Utterance,
  sourceText: string,
  sourceLanguage: TargetLanguage | "unknown",
  translations: TranslationCandidates,
) {
  let ja = row.ja;
  let en = row.en;
  if (
    sourceLanguage !== "unknown" &&
    row.sourceLanguage !== "unknown" &&
    sourceLanguage !== row.sourceLanguage
  ) {
    ja = "";
    en = "";
  }
  if (sourceLanguage === "ja") {
    ja = sourceText;
    if (translations.en) en = translations.en;
  }
  if (sourceLanguage === "en") {
    en = sourceText;
    if (translations.ja) ja = translations.ja;
  }
  return { ja, en };
}

export function replaceRow(rows: Utterance[], index: number, row: Utterance) {
  if (rows[index] === row) return rows;
  const next = rows.slice();
  next[index] = row;
  return next;
}
