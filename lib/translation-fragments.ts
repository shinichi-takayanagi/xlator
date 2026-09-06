import type { TargetLanguage, Utterance } from "./translation-types";
import { findTranslationRowIndex } from "./utterance-alignment.ts";

export const PENDING_TRANSLATION_MAX_AGE_MS = 3_000;
export const PENDING_TRANSLATION_MAX_FRAGMENTS = 256;
export const PENDING_TRANSLATION_MAX_CHARACTERS = 65_536;
const TIMESTAMP_RESOLUTION_MS = 200;

export type TranslationFragment = {
  targetLanguage: TargetLanguage;
  text: string;
  elapsedMs?: number;
  receivedElapsedMs: number;
  receivedAt: number;
};

export type AssignedTranslationFragment = TranslationFragment & { rowId: string };

type PendingFragment = TranslationFragment & {
  existingRowIds: string[];
  nextRowId?: string;
};

/** Keeps each delta's timing and lifetime independent of subsequent deltas. */
export class TranslationFragmentBuffer {
  private pending: PendingFragment[] = [];
  private anchors = new Map<TargetLanguage, { rowId: string; receivedAt: number }>();

  clear() {
    this.pending = [];
    this.anchors.clear();
  }

  get pendingCount() {
    return this.pending.length;
  }

  receive(
    rows: Utterance[],
    activeRowId: string | null,
    fragment: TranslationFragment,
  ): AssignedTranslationFragment[] {
    const assigned = this.reconcile(rows, activeRowId, fragment.receivedAt);
    const hasTimestamp = fragment.elapsedMs !== undefined;
    let index = hasTimestamp
      ? findTranslationRowIndex(rows, activeRowId, fragment.elapsedMs)
      : -1;

    let usedAnchor = false;
    if (!hasTimestamp) {
      const anchor = this.anchors.get(fragment.targetLanguage);
      if (anchor && fragment.receivedAt - anchor.receivedAt <= PENDING_TRANSLATION_MAX_AGE_MS) {
        index = rows.findIndex((row) => row.id === anchor.rowId);
        usedAnchor = index >= 0;
      }
      if (index < 0) {
        // Old history must not make all future untimed output unusable.
        const recentRows = rows.filter((row) => (
          findTranslationRowIndex([row], activeRowId, fragment.receivedElapsedMs) === 0
        ));
        if (recentRows.length === 1) {
          index = rows.findIndex((row) => row.id === recentRows[0].id);
        }
      }
    }

    if (index >= 0) {
      const rowId = rows[index].id;
      assigned.push({ ...fragment, rowId });
      // Missing timestamps do not prolong an old stream anchor indefinitely.
      if (!usedAnchor) {
        this.setAnchor(fragment.targetLanguage, rowId, fragment.receivedAt);
      }
    } else {
      this.pending.push({ ...fragment, existingRowIds: rows.map((row) => row.id) });
      this.prune(fragment.receivedAt);
    }
    return assigned;
  }

  reconcile(
    rows: Utterance[],
    activeRowId: string | null,
    now: number,
  ): AssignedTranslationFragment[] {
    this.prune(now);
    const assigned: AssignedTranslationFragment[] = [];
    this.pending = this.pending.filter((fragment) => {
      const firstNewRow = rows.find((row) => !fragment.existingRowIds.includes(row.id));
      // Remember the first subsequent row, including if it is later removed.
      fragment.nextRowId ??= firstNewRow?.id;
      const index = fragment.elapsedMs === undefined
        ? -1
        : findTranslationRowIndex(rows, activeRowId, fragment.elapsedMs);
      let row = index < 0 ? undefined : rows[index];

      if (!row && fragment.elapsedMs === undefined && fragment.existingRowIds.length === 0) {
        row = rows.find((candidate) => (
          candidate.id === fragment.nextRowId &&
          Math.abs((candidate.startMs ?? 0) - fragment.receivedElapsedMs) <= TIMESTAMP_RESOLUTION_MS
        ));
      }
      const isNearNewRow = (candidate: Utterance) => (
        !fragment.existingRowIds.includes(candidate.id) &&
        (fragment.elapsedMs !== undefined || candidate.id === fragment.nextRowId) &&
        Math.abs((candidate.startMs ?? 0) - (fragment.elapsedMs ?? fragment.receivedElapsedMs)) <= TIMESTAMP_RESOLUTION_MS
      );
      if (!row || (!fragment.existingRowIds.includes(row.id) && !isNearNewRow(row))) {
        row = rows.find(isNearNewRow);
      }
      if (!row) return true;

      assigned.push({ ...fragment, rowId: row.id });
      if (fragment.elapsedMs !== undefined) {
        this.setAnchor(fragment.targetLanguage, row.id, fragment.receivedAt);
      }
      return false;
    });
    return assigned;
  }

  private setAnchor(targetLanguage: TargetLanguage, rowId: string, receivedAt: number) {
    const previous = this.anchors.get(targetLanguage);
    // Resolving an older pending fragment must not replace newer stream evidence.
    if (!previous || receivedAt >= previous.receivedAt) {
      this.anchors.set(targetLanguage, { rowId, receivedAt });
    }
  }

  private prune(now: number) {
    this.pending = this.pending.filter((fragment) => (
      now - fragment.receivedAt <= PENDING_TRANSLATION_MAX_AGE_MS
    ));
    let characters = this.pending.reduce((count, fragment) => count + fragment.text.length, 0);
    while (
      this.pending.length > PENDING_TRANSLATION_MAX_FRAGMENTS ||
      characters > PENDING_TRANSLATION_MAX_CHARACTERS
    ) {
      characters -= this.pending.shift()!.text.length;
    }
  }
}
