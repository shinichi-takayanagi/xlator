import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETE_UTTERANCE_SILENCE_MS,
  DEFAULT_UTTERANCE_SILENCE_MS,
  SPEECH_CONFIRMATION_MS,
  getVadSilenceDurationMs,
} from "../lib/local-vad.ts";

test("shortens local VAD silence after complete utterances", () => {
  assert.equal(COMPLETE_UTTERANCE_SILENCE_MS, 320);
  assert.equal(DEFAULT_UTTERANCE_SILENCE_MS, 450);
  assert.equal(SPEECH_CONFIRMATION_MS, 120);
  assert.equal(getVadSilenceDurationMs("今日は暑いですね。"), 320);
  assert.equal(getVadSilenceDurationMs("Are you okay?\""), 320);
  assert.equal(getVadSilenceDurationMs("まだ話している途中"), 450);
  assert.ok(DEFAULT_UTTERANCE_SILENCE_MS < 600);
});
