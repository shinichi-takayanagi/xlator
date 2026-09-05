import assert from "node:assert/strict";
import test from "node:test";
import {
  PENDING_TRANSLATION_MAX_CHARACTERS,
  PENDING_TRANSLATION_MAX_FRAGMENTS,
  TranslationFragmentBuffer,
} from "../lib/translation-fragments.ts";
import {
  alignSourceAndTranslation,
  appendTranslationCandidate,
  createLiveUtterance,
} from "../lib/utterance-alignment.ts";

function fragment(text, elapsedMs, receivedAt, targetLanguage = "en") {
  return { text, elapsedMs, receivedAt, receivedElapsedMs: receivedAt, targetLanguage };
}

function row(id, startMs, sourceLanguage = "ja") {
  return { ...createLiveUtterance(1, startMs, id), sourceLanguage, endMs: startMs + 1_000 };
}

for (const nextLanguage of ["ja", "en"]) {
  test(`late A translation stays on A while ${nextLanguage} utterance B is active`, () => {
    const buffer = new TranslationFragmentBuffer();
    const rows = [row("A", 1_000), row("B", 3_000, nextLanguage)];
    const candidates = new Map();
    for (const output of [fragment("First ", 1_200, 3_100), fragment("turn.", 1_800, 3_300)]) {
      for (const assignment of buffer.receive(rows, "B", output)) {
        candidates.set(assignment.rowId, appendTranslationCandidate(
          candidates.get(assignment.rowId) ?? {}, assignment.targetLanguage, assignment.text,
        ));
      }
    }
    assert.deepEqual(alignSourceAndTranslation(rows[0], "最初の発話。", "ja", candidates.get("A")), {
      ja: "最初の発話。", en: "First turn.",
    });
    assert.equal(candidates.has("B"), false);
    assert.equal(buffer.receive(rows, "B", fragment("Second.", 3_200, 3_500))[0].rowId, "B");
  });
}

test("missing timestamps continue a recent target-specific anchor without choosing the active row", () => {
  const buffer = new TranslationFragmentBuffer();
  const rows = [row("A", 1_000), row("B", 3_000)];
  buffer.receive(rows, "B", fragment("First", 1_500, 3_100));
  const continuation = buffer.receive(rows, "B", fragment(" turn.", undefined, 3_200));
  assert.equal(continuation[0].rowId, "A");
  assert.deepEqual(buffer.receive(rows, "B", fragment("不明", undefined, 3_200, "ja")), []);
  const recovered = buffer.receive(rows, "B", fragment("Recovered", undefined, 6_101));
  assert.equal(recovered[0].rowId, "B");
  assert.equal(buffer.pendingCount, 1);
});

test("untimed output recovers after competing older rows expire", () => {
  const buffer = new TranslationFragmentBuffer();
  assert.equal(buffer.receive([row("A", 1_000)], null, fragment("First.", undefined, 2_100))[0].rowId, "A");
  const history = [row("Old", 0), row("Current", 6_000)];
  const fresh = new TranslationFragmentBuffer();
  assert.equal(fresh.receive(history, "Current", fragment("Current", undefined, 6_100))[0].rowId, "Current");
  fresh.clear();
  assert.deepEqual(fresh.receive([row("A", 1_000)], null, fragment("Stale", undefined, 6_000)), []);
});

test("buffers independent fragments with original receipt times for distinct upcoming rows", () => {
  const buffer = new TranslationFragmentBuffer();
  buffer.receive([], null, fragment("First.", 1_000, 1_100));
  buffer.receive([], null, fragment("Second.", 3_000, 3_100));
  const first = buffer.reconcile([row("A", 1_100)], "A", 3_100);
  assert.deepEqual(first.map(({ rowId, text, receivedAt }) => ({ rowId, text, receivedAt })), [
    { rowId: "A", text: "First.", receivedAt: 1_100 },
  ]);
  const second = buffer.reconcile([row("A", 1_100), row("B", 3_100)], "B", 3_200);
  assert.equal(second[0].rowId, "B");
  assert.equal(second[0].text, "Second.");
  assert.equal(buffer.pendingCount, 0);
});

test("new deltas cannot refresh stale pending text or transfer it to the next utterance", () => {
  const buffer = new TranslationFragmentBuffer();
  buffer.receive([], null, fragment("Old", 1_000, 1_100));
  buffer.receive([], null, fragment("New", 4_000, 4_000));
  const assigned = buffer.reconcile([row("B", 4_000)], "B", 4_101);
  assert.deepEqual(assigned.map(({ text }) => text), ["New"]);
  assert.equal(buffer.pendingCount, 0);
  const unmatched = new TranslationFragmentBuffer();
  unmatched.receive([], null, fragment("Old", 1_000, 1_100));
  assert.deepEqual(unmatched.reconcile([row("B", 3_000)], "B", 3_100), []);
});

test("untimed pre-row output only uses a nearby first row, never a later replacement", () => {
  const buffer = new TranslationFragmentBuffer();
  buffer.receive([], null, fragment("Near", undefined, 1_000));
  assert.equal(buffer.reconcile([row("A", 1_100)], "A", 1_100)[0].rowId, "A");
  const unmatched = new TranslationFragmentBuffer();
  unmatched.receive([], null, fragment("Unknown", undefined, 1_000));
  assert.deepEqual(unmatched.reconcile([row("A", 2_000)], "A", 2_000), []);
  assert.deepEqual(unmatched.reconcile([row("B", 1_100)], "B", 2_100), []);
});

test("pending storage is bounded by fragment count and text size, and clear removes anchors", () => {
  const buffer = new TranslationFragmentBuffer();
  for (let index = 0; index < PENDING_TRANSLATION_MAX_FRAGMENTS + 1; index += 1) {
    buffer.receive([], null, fragment(String(index), 1_000, 1_000));
  }
  assert.equal(buffer.pendingCount, PENDING_TRANSLATION_MAX_FRAGMENTS);
  buffer.receive([], null, fragment("x".repeat(PENDING_TRANSLATION_MAX_CHARACTERS + 1), 1_000, 1_000));
  assert.equal(buffer.pendingCount, 0);
  const rows = [row("A", 1_000), row("B", 3_000)];
  buffer.receive(rows, "B", fragment("First", 1_200, 3_100));
  buffer.clear();
  assert.deepEqual(buffer.receive(rows, "B", fragment("Unknown", undefined, 3_200)), []);
});


test("unknown source keeps both candidates until source detection chooses the opposite side", () => {
  const buffer = new TranslationFragmentBuffer();
  const unknown = row("A", 1_000, "unknown");
  let candidates = {};
  for (const output of [fragment("Hello", 1_200, 1_300), fragment("こんにちは", 1_200, 1_400, "ja")]) {
    for (const assignment of buffer.receive([unknown], "A", output)) {
      candidates = appendTranslationCandidate(candidates, assignment.targetLanguage, assignment.text);
    }
  }
  assert.deepEqual(alignSourceAndTranslation(unknown, "123", "unknown", candidates), { ja: "", en: "" });
  assert.deepEqual(alignSourceAndTranslation(unknown, "こんにちは。", "ja", candidates), { ja: "こんにちは。", en: "Hello" });
  assert.deepEqual(alignSourceAndTranslation(unknown, "Hello!", "en", candidates), { ja: "こんにちは", en: "Hello!" });
});

test("pending lifetime uses receipt age with an inclusive three-second boundary", () => {
  const atBoundary = new TranslationFragmentBuffer();
  atBoundary.receive([], null, fragment("Kept", 1_000, 10_000));
  assert.equal(atBoundary.reconcile([row("A", 1_000)], "A", 13_000)[0].text, "Kept");
  const expired = new TranslationFragmentBuffer();
  expired.receive([], null, fragment("Expired", 1_000, 10_000));
  assert.deepEqual(expired.reconcile([row("A", 1_000)], "A", 13_001), []);
  assert.equal(expired.pendingCount, 0);
});


test("resolving older pending text does not replace a newer target anchor", () => {
  const buffer = new TranslationFragmentBuffer();
  buffer.receive([], null, fragment("Older", 1_000, 1_000));
  buffer.receive([row("B", 2_000)], "B", fragment("Newer", 2_000, 2_000));
  const rows = [row("A", 1_000), row("B", 2_000)];
  assert.equal(buffer.reconcile(rows, "B", 2_100)[0].rowId, "A");
  assert.equal(buffer.receive(rows, "B", fragment(" continued", undefined, 2_200))[0].rowId, "B");
});
