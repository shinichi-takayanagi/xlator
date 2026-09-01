import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveUtterance,
  detectLanguage,
  replaceRow,
} from "../lib/utterance-alignment.ts";

test("creates a draft aligned row as soon as speech starts", () => {
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

test("immutably replaces an aligned utterance", () => {
  const rows = [
    { id: "1", sequence: 1, at: "00:01", sourceLanguage: "ja", startMs: 1000, ja: "一", en: "one" },
    { id: "2", sequence: 2, at: "00:03", sourceLanguage: "en", startMs: 3000, ja: "二", en: "two" },
  ];

  const replacement = { ...rows[1], en: "Two" };
  const next = replaceRow(rows, 1, replacement);
  assert.notEqual(next, rows);
  assert.equal(next[0], rows[0]);
  assert.equal(next[1], replacement);
});
