import type { TargetLanguage, Utterance } from "./translation-types";

export type SourceCandidate = {
  text: string;
  endMs: number;
};

export type SourceCandidates = Partial<Record<TargetLanguage, SourceCandidate>>;

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

export function selectSourceSession(
  candidates: SourceCandidates,
  selectedSession: TargetLanguage | undefined,
  fallbackSession: TargetLanguage,
) {
  let bestSession = selectedSession && candidates[selectedSession]
    ? selectedSession
    : fallbackSession;

  for (const candidateSession of ["en", "ja"] as const) {
    const candidate = candidates[candidateSession];
    const best = candidates[bestSession];
    const isAheadInTime = candidate && best && candidate.endMs > best.endMs + 600;
    if (
      candidate &&
      (!best || candidate.text.length > best.text.length || isAheadInTime)
    ) {
      bestSession = candidateSession;
    }
  }

  return bestSession;
}

export function replaceRow(rows: Utterance[], index: number, row: Utterance) {
  if (rows[index] === row) return rows;
  const next = rows.slice();
  next[index] = row;
  return next;
}
