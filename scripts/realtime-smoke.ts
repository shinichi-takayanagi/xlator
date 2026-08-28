#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  evaluateRealtimeSmoke,
  loadRealtimeSmokeManifest,
  prepareWavPcm16,
  runRealtimeSmokeCase,
} from "../lib/realtime-smoke.ts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percentage(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

async function main() {
  const fixturePath = argument("--fixture") ?? process.env.REALTIME_SMOKE_FIXTURE;
  const selectedCase = argument("--case") ?? process.env.REALTIME_SMOKE_CASE;
  const validateOnly = process.argv.includes("--validate-only");
  if (!fixturePath) {
    throw new Error(
      "Fixture is required. Pass --fixture <manifest.json> or set REALTIME_SMOKE_FIXTURE.",
    );
  }

  const { manifest, resolveAudioPath } = await loadRealtimeSmokeManifest(fixturePath);
  const cases = selectedCase
    ? manifest.cases.filter((smokeCase) => smokeCase.id === selectedCase)
    : manifest.cases;
  if (cases.length === 0) throw new Error(`Smoke case not found: ${selectedCase}`);

  const preparedCases = await Promise.all(cases.map(async (smokeCase) => ({
    smokeCase,
    audio: prepareWavPcm16(await readFile(resolveAudioPath(smokeCase.audio))),
  })));
  if (validateOnly) {
    for (const { smokeCase, audio } of preparedCases) {
      console.log(
        `validated ${smokeCase.id}: ${audio.durationMs.toFixed(0)}ms, ` +
          `${audio.originalSampleRate}Hz, ${audio.originalChannels}ch`,
      );
    }
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for an API smoke test.");
  let failed = false;
  for (const { smokeCase, audio } of preparedCases) {
    console.log(`\n[${smokeCase.id}] streaming ${audio.durationMs.toFixed(0)}ms to Realtime API`);
    const observation = await runRealtimeSmokeCase({
      smokeCase,
      audio,
      apiKey,
      model: process.env.OPENAI_REALTIME_TRANSLATION_MODEL,
      transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL,
      safetyIdentifier: process.env.OPENAI_SAFETY_IDENTIFIER,
    });
    const evaluation = evaluateRealtimeSmoke(smokeCase, observation);
    console.log(`source:      ${observation.sourceTranscript}`);
    console.log(`translation: ${observation.translationTranscript}`);
    for (const assertion of evaluation.assertions) {
      console.log(`${assertion.passed ? "PASS" : "FAIL"} ${assertion.name}: ${assertion.detail}`);
    }
    console.log(
      `latency: source=${observation.latencyMs.firstSourceTranscript ?? "n/a"}ms, ` +
        `translation=${observation.latencyMs.firstTranslationTranscript ?? "n/a"}ms, ` +
        `audio=${observation.latencyMs.firstTranslatedAudio ?? "n/a"}ms, ` +
        `closed=${observation.latencyMs.sessionClosed}ms`,
    );
    console.log(
      `metrics: source ${evaluation.metrics.sourceMetric}=${percentage(evaluation.metrics.sourceErrorRate)}, ` +
        `translation ${evaluation.metrics.translationMetric ?? "error"}=` +
        `${percentage(evaluation.metrics.translationErrorRate)}, ` +
        `terms=${percentage(evaluation.metrics.translationTermCoverage)}`,
    );
    failed ||= !evaluation.passed;
  }
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
