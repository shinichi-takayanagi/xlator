import type { TargetLanguage, Utterance } from "./translation-types";

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

export function replaceRow(rows: Utterance[], index: number, row: Utterance) {
  if (rows[index] === row) return rows;
  const next = rows.slice();
  next[index] = row;
  return next;
}
