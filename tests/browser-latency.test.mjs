import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserLatencyMeasurement, createTranscriptLatencyTracker } from "../lib/browser-latency.ts";

const row = { id: "row-1", sequence: 1 };
function setup() {
  const records = [];
  const tracker = createTranscriptLatencyTracker((...args) => records.push(createBrowserLatencyMeasurement(...args)));
  const commit = (kind, sourceFinal = false) => ({ rowId: row.id, sequence: 1, kind, language: "ja", sourceFinal });
  return { tracker, records, commit };
}

test("creates rounded non-negative browser latency records", () => {
  assert.deepEqual(createBrowserLatencyMeasurement(2, "speech-to-source-dom", 100.2, 215.8), {
    sequence: 2, metric: "speech-to-source-dom", durationMs: 116,
  });
});

test("separates receipt, adoption, DOM commit, and late source completion", () => {
  const { tracker, records, commit } = setup();
  tracker.speechStarted(row.id, 100);
  tracker.sourceReceived(row, 500, false);
  tracker.sourceReceived(row, 510, false);
  tracker.adopted(row, "source", "ja", 520);
  assert.equal(records.length, 2, "adopting text is not a DOM commit");
  tracker.domCommitted(commit("source"), 530);
  tracker.speechEnded(row, 600, 1050);
  tracker.sourceReceived(row, 1500, true);
  tracker.domCommitted(commit("source", true), 1510);
  tracker.domCommitted(commit("source", true), 1520);
  assert.deepEqual(records, [
    { sequence: 1, metric: "speech-to-source-receipt", durationMs: 400 },
    { sequence: 1, metric: "source-receipt-to-adoption", durationMs: 20 },
    { sequence: 1, metric: "source-adoption-to-dom", durationMs: 10 },
    { sequence: 1, metric: "speech-to-source-dom", durationMs: 430 },
    { sequence: 1, metric: "silence-to-speech-end", durationMs: 450 },
    { sequence: 1, metric: "silence-to-source-completed", durationMs: 900 },
    { sequence: 1, metric: "source-completed-to-dom", durationMs: 10 },
  ]);
  assert.equal(JSON.stringify(records).includes("sourceText"), false);
});

test("missing VAD emits processing metrics without fabricated speech latency", () => {
  const { tracker, records, commit } = setup();
  tracker.sourceReceived(row, 1000, true);
  tracker.adopted(row, "source", "ja", 1001);
  tracker.domCommitted(commit("source", true), 1010);
  assert.deepEqual(records.map((record) => record.metric), [
    "source-receipt-to-adoption", "source-adoption-to-dom", "source-completed-to-dom",
  ]);
});

test("translation buffering measures original receipt and does not double count language corrections", () => {
  const { tracker, records, commit } = setup();
  tracker.speechStarted(row.id, 100);
  tracker.translationReceived(row.id, "ja", 300);
  tracker.translationReceived(row.id, "ja", 500);
  tracker.translationReceived(row.id, "en", 400);
  tracker.adopted(row, "translation", "ja", 800);
  tracker.domCommitted(commit("translation"), 810);
  tracker.adopted(row, "translation", "en", 900);
  tracker.domCommitted({ ...commit("translation"), language: "en" }, 910);
  assert.deepEqual(records, [
    { sequence: 1, metric: "speech-to-translation-receipt", durationMs: 200 },
    { sequence: 1, metric: "translation-receipt-to-adoption", durationMs: 500 },
    { sequence: 1, metric: "translation-adoption-to-dom", durationMs: 10 },
    { sequence: 1, metric: "speech-to-translation-dom", durationMs: 710 },
  ]);
});
