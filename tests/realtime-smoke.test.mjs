import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  evaluateRealtimeSmoke,
  prepareWavPcm16,
  summarizeLatencyValues,
  transcriptErrorRate,
  translationTermCoverage,
  validateRealtimeSmokeManifest,
} from "../lib/realtime-smoke.ts";

function pcm16Wav({ sampleRate = 48_000, channels = 2, frames = 480 } = {}) {
  const dataSize = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(frame % 2 === 0 ? 1_000 : -1_000, 44 + (frame * channels + channel) * 2);
    }
  }
  return buffer;
}

test("validates smoke fixture fields and unique case IDs", () => {
  const manifest = validateRealtimeSmokeManifest({
    version: 1,
    cases: [{
      id: "ja-to-en",
      audio: "ja.wav",
      sourceLanguage: "ja",
      targetLanguage: "en",
      expectedSource: "次の会議は三時です。",
    }],
  });
  assert.equal(manifest.cases[0].id, "ja-to-en");
  assert.throws(() => validateRealtimeSmokeManifest({ version: 1, cases: [] }));
});

test("downmixes and resamples PCM16 WAV to 24kHz mono", () => {
  const prepared = prepareWavPcm16(pcm16Wav());
  assert.equal(prepared.originalSampleRate, 48_000);
  assert.equal(prepared.originalChannels, 2);
  assert.equal(prepared.pcm16.length, 480);
  assert.equal(Math.round(prepared.durationMs), 10);
});

test("uses WER for English and normalized CER for Japanese", () => {
  assert.equal(transcriptErrorRate("Hello, world!", "hello world", "en"), 0);
  assert.equal(transcriptErrorRate("今日は晴れ", "今日は雨", "ja"), 2 / 4);
});

test("accepts alternative required translation terms", () => {
  assert.equal(
    translationTermCoverage("The next meeting is at 3 p.m.", ["meeting", ["3 p.m.", "three"]]),
    1,
  );
});

test("summarizes latency values with nearest-rank p50 and p95", () => {
  const summary = summarizeLatencyValues([10, 20, null, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.deepEqual(summary, { sampleCount: 10, p50: 50, p95: 100 });
  assert.deepEqual(
    summarizeLatencyValues([null]),
    { sampleCount: 0, p50: null, p95: null },
  );
});

test("evaluates transcript, translation, terms, and audio independently", () => {
  const evaluation = evaluateRealtimeSmoke(
    {
      id: "ja-to-en",
      audio: "ja.wav",
      sourceLanguage: "ja",
      targetLanguage: "en",
      expectedSource: "次の会議は午後三時です",
      expectedTranslation: "The next meeting is at three in the afternoon",
      requiredTranslationTerms: ["meeting", ["three", "3"]],
    },
    {
      sourceTranscript: "次の会議は午後三時です。",
      translationTranscript: "The next meeting is at three in the afternoon.",
      translatedAudioBytes: 48_000,
      durationMs: 1_000,
      latencyMs: {
        firstSourceTranscript: 100,
        firstTranslationTranscript: 200,
        firstTranslatedAudio: 180,
        sessionClosed: 1_300,
      },
    },
  );
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.assertions.length, 6);
});

test("validates a fixture through the smoke CLI without calling the API", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "xlator-smoke-"));
  try {
    await writeFile(join(fixtureDirectory, "speech.wav"), pcm16Wav());
    await writeFile(
      join(fixtureDirectory, "manifest.json"),
      JSON.stringify({
        version: 1,
        cases: [{
          id: "offline-validation",
          audio: "speech.wav",
          sourceLanguage: "en",
          targetLanguage: "ja",
          expectedSource: "Hello",
        }],
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/realtime-smoke.ts", "--fixture", join(fixtureDirectory, "manifest.json"), "--validate-only"],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /validated offline-validation/);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
