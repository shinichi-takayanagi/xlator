import assert from "node:assert/strict";
import test from "node:test";
import {
  alignSourceAndTranslation,
  appendTranslationCandidate,
  bindTranscriptionItemToOldestRow,
  createLiveUtterance,
  detectLanguage,
  findLastRowStartingAtOrBefore,
  findReusableTranscriptionRow,
  findTranslationRowIndex,
  replaceRow,
} from "../lib/utterance-alignment.ts";

test("creates a draft aligned row for a confirmed speech event", () => {
  assert.deepEqual(createLiveUtterance(3, 65_432, "live-test-3"), {
    id: "live-test-3",
    sequence: 3,
    at: "01:05",
    startMs: 65_432,
    endMs: 65_432,
    sourceLanguage: "unknown",
    sourceText: "",
    ja: "",
    en: "",
    status: "draft",
  });
});

test("detects Japanese and English source text", () => {
  assert.equal(detectLanguage("今日は暑いですね"), "ja");
  assert.equal(detectLanguage("Yes, too hot!"), "en");
  assert.equal(detectLanguage("123!?"), "unknown");
});

test("buffers both Translation targets and renders only the opposite language", () => {
  let candidates = appendTranslationCandidate({}, "en", "Good ");
  candidates = appendTranslationCandidate(candidates, "en", "morning.");
  candidates = appendTranslationCandidate(candidates, "ja", "おはようございます。");

  const row = createLiveUtterance(1, 0, "live-test-1");
  assert.deepEqual(
    alignSourceAndTranslation(row, "おはようございます。", "ja", candidates),
    { ja: "おはようございます。", en: "Good morning." },
  );
  assert.deepEqual(
    alignSourceAndTranslation(row, "Good morning.", "en", candidates),
    { ja: "おはようございます。", en: "Good morning." },
  );
});

test("locates and immutably replaces an aligned utterance", () => {
  const rows = [
    { id: "1", sequence: 1, at: "00:01", sourceLanguage: "ja", startMs: 1000, ja: "一", en: "one" },
    { id: "2", sequence: 2, at: "00:03", sourceLanguage: "en", startMs: 3000, ja: "二", en: "two" },
  ];

  assert.equal(findLastRowStartingAtOrBefore(rows, 999), -1);
  assert.equal(findLastRowStartingAtOrBefore(rows, 2999), 0);
  assert.equal(findLastRowStartingAtOrBefore(rows, 3400), 1);

  const replacement = { ...rows[1], en: "Two" };
  const next = replaceRow(rows, 1, replacement);
  assert.notEqual(next, rows);
  assert.equal(next[0], rows[0]);
  assert.equal(next[1], replacement);
});

test("never reuses a row already bound to a different transcription item", () => {
  const itemRows = new Map([["item-1", "row-1"]]);
  const rowItems = new Map([["row-1", "item-1"]]);

  assert.equal(
    findReusableTranscriptionRow("item-1", itemRows, rowItems, "row-1"),
    "row-1",
  );
  assert.equal(
    findReusableTranscriptionRow("item-2", itemRows, rowItems, "row-1"),
    null,
  );
  assert.equal(
    findReusableTranscriptionRow("item-2", itemRows, rowItems, null),
    null,
  );
  assert.equal(
    findReusableTranscriptionRow(
      "item-2",
      itemRows,
      rowItems,
      "row-2",
      ["row-1-finished", "row-2"],
    ),
    "row-1-finished",
  );
});

test("binds committed item IDs before out-of-order transcript events arrive", () => {
  const itemRows = new Map();
  const rowItems = new Map();
  const unboundRows = ["row-1", "row-2"];

  assert.equal(
    bindTranscriptionItemToOldestRow(
      "item-1",
      itemRows,
      rowItems,
      unboundRows,
    ),
    "row-1",
  );
  assert.equal(
    bindTranscriptionItemToOldestRow(
      "item-2",
      itemRows,
      rowItems,
      unboundRows,
    ),
    "row-2",
  );
  assert.equal(
    findReusableTranscriptionRow("item-2", itemRows, rowItems, null),
    "row-2",
  );
  assert.equal(
    findReusableTranscriptionRow("item-1", itemRows, rowItems, null),
    "row-1",
  );
});

test("assigns translation only to an existing current row", () => {
  const rows = [
    { id: "row-1", sequence: 1, at: "00:01", sourceLanguage: "ja", startMs: 1_000, endMs: 2_000, ja: "一", en: "one", status: "final" },
    { id: "row-2", sequence: 2, at: "00:04", sourceLanguage: "en", startMs: 4_000, endMs: 4_500, ja: "二", en: "two", status: "draft" },
  ];

  assert.equal(findTranslationRowIndex([], null, 1_000), -1);
  assert.equal(findTranslationRowIndex(rows, "row-2"), 1);
  assert.equal(findTranslationRowIndex(rows, "row-2", 1_500), 1);
  assert.equal(findTranslationRowIndex(rows, "row-2", 4_100), 1);
  assert.equal(findTranslationRowIndex(rows, null, 8_000), -1);
});
