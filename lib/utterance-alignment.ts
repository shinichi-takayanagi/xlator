import type { TargetLanguage, Utterance } from "./translation-types";

export type TranslationCandidates = Partial<Record<TargetLanguage, string>>;

const TRANSLATION_TIMESTAMP_RESOLUTION_MS = 200;
const TRANSLATION_ROW_STALE_MS = 3_000;

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

export function findReusableTranscriptionRow(
  itemId: string | undefined,
  itemRows: ReadonlyMap<string, string>,
  rowItems: ReadonlyMap<string, string>,
  activeRowId: string | null,
  unboundRowIds: readonly string[] = [],
) {
  if (itemId) {
    const mappedRowId = itemRows.get(itemId);
    if (mappedRowId) return mappedRowId;

    const queuedRowId = unboundRowIds.find((rowId) => !rowItems.has(rowId));
    if (queuedRowId) return queuedRowId;
  }

  if (!activeRowId) return null;
  const activeItemId = rowItems.get(activeRowId);
  if (!itemId || !activeItemId || activeItemId === itemId) return activeRowId;
  return null;
}

export function bindTranscriptionItemToOldestRow(
  itemId: string,
  itemRows: Map<string, string>,
  rowItems: Map<string, string>,
  unboundRowIds: readonly string[],
) {
  const existingRowId = itemRows.get(itemId);
  if (existingRowId) return existingRowId;

  const rowId = unboundRowIds.find((candidate) => !rowItems.has(candidate));
  if (!rowId) return null;

  itemRows.set(itemId, rowId);
  rowItems.set(rowId, itemId);
  return rowId;
}

export function findTranslationRowIndex(
  rows: Utterance[],
  activeRowId: string | null,
  elapsedMs?: number,
) {
  if (rows.length === 0) return -1;
  if (elapsedMs === undefined) {
    // An active row alone does not identify a delayed, untimed output fragment.
    return rows.length === 1 && rows[0].id === activeRowId ? 0 : -1;
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return -1;

  let timedIndex = findLastRowStartingAtOrBefore(rows, elapsedMs);
  if (timedIndex < 0) {
    // Allow coarse timestamps just before the first local VAD confirmation.
    // Never look ahead across an existing row's next-turn boundary.
    if ((rows[0].startMs ?? 0) - elapsedMs > TRANSLATION_TIMESTAMP_RESOLUTION_MS) {
      return -1;
    }
    timedIndex = 0;
  }

  const timedRow = rows[timedIndex];
  const timedEndMs = timedRow.speechEndMs ?? timedRow.endMs ?? timedRow.startMs ?? 0;
  if (
    timedRow.id !== activeRowId &&
    elapsedMs > timedEndMs + TRANSLATION_ROW_STALE_MS
  ) {
    return -1;
  }
  return timedIndex;
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
