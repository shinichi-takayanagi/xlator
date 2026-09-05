import assert from "node:assert/strict";
import test from "node:test";
import { getTranscriptDisplay, hasSameTranscriptDisplay } from "../lib/transcript-display.ts";

const row = { id: "one", sequence: 1, at: "00:00", sourceLanguage: "unknown", sourceText: "123", ja: "", en: "", status: "draft" };

test("shows numeric source once with an explicit unclassified label", () => {
  assert.deepEqual(getTranscriptDisplay(row, "ja"), { text: "123", kind: "source", label: "原文・言語判定中", sourceFinal: false, textLanguage: undefined });
  assert.equal(getTranscriptDisplay(row, "en").text, "");
  assert.equal(getTranscriptDisplay({ ...row, sourceLanguageStatus: "final" }, "ja").label, "原文・言語不明");
});

test("visible comparisons ignore only fields that cannot affect that panel", () => {
  const source = { ...row, sourceLanguage: "ja", sourceLanguageStatus: "provisional", ja: "こんにちは", en: "Hello" };
  assert.equal(hasSameTranscriptDisplay(source, { ...source, en: "Hello there" }, "ja"), true);
  assert.equal(hasSameTranscriptDisplay(source, { ...source, en: "Hello there" }, "en"), false);
  for (const patch of [{ ja: "こんばんは" }, { status: "final" }, { sourceLanguageStatus: "final" }, { sequence: 2 }, { at: "00:01" }, { id: "two" }, { sourceLanguage: "en" }]) {
    assert.equal(hasSameTranscriptDisplay(source, { ...source, ...patch }, "ja"), false);
  }
  assert.equal(hasSameTranscriptDisplay(row, { ...row, sourceText: "1234" }, "ja"), false);
  assert.equal(hasSameTranscriptDisplay(row, { ...row, sourceText: "1234" }, "en"), true);
});
