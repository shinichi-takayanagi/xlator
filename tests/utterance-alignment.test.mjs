import assert from "node:assert/strict";
import test from "node:test";
import {
  detectLanguage,
  findLastRowStartingAtOrBefore,
  replaceRow,
  selectSourceSession,
} from "../lib/utterance-alignment.ts";

test("detects Japanese and English source text", () => {
  assert.equal(detectLanguage("今日は暑いですね"), "ja");
  assert.equal(detectLanguage("Yes, too hot!"), "en");
  assert.equal(detectLanguage("123!?"), "unknown");
});

test("prefers the longer source transcript candidate", () => {
  const candidates = {
    en: { text: "今日は", endMs: 1000 },
    ja: { text: "今日は暑いですね", endMs: 1000 },
  };

  assert.equal(selectSourceSession(candidates, "en", "en"), "ja");
});

test("switches to a candidate that advances by more than 600 ms", () => {
  const candidates = {
    en: { text: "This transcript is longer", endMs: 1000 },
    ja: { text: "短い", endMs: 1601 },
  };

  assert.equal(selectSourceSession(candidates, "en", "en"), "ja");
});

test("locates and immutably replaces an aligned utterance", () => {
  const rows = [
    { id: "1", sequence: 1, at: "00:01", sourceLanguage: "ja", startMs: 1000, ja: "一", en: "one" },
    { id: "2", sequence: 2, at: "00:03", sourceLanguage: "en", startMs: 3000, ja: "二", en: "two" },
  ];

  assert.equal(findLastRowStartingAtOrBefore(rows, 2999), 0);
  assert.equal(findLastRowStartingAtOrBefore(rows, 3400), 1);

  const replacement = { ...rows[1], en: "Two" };
  const next = replaceRow(rows, 1, replacement);
  assert.notEqual(next, rows);
  assert.equal(next[0], rows[0]);
  assert.equal(next[1], replacement);
});
