#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  evaluateRealtimeSmoke,
  loadRealtimeSmokeManifest,
  prepareWavPcm16,
  runRealtimeSmokeCase,
  summarizeLatencyValues,
  type RealtimeSmokeObservation,
} from "../lib/realtime-smoke.ts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percentage(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function positiveInteger(value: string | undefined, name: string) {
  if (value === undefined) return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function latencySummary(label: string, values: Array<number | null>) {
  const summary = summarizeLatencyValues(values);
  return `${label}: n=${summary.sampleCount}, p50=${summary.p50 ?? "n/a"}ms, ` +
    `p95=${summary.p95 ?? "n/a"}ms`;
}

function printLatencySummary(caseId: string, observations: RealtimeSmokeObservation[]) {
  const source = observations.map((observation) => observation.latencyMs.firstSourceTranscript);
  const translation = observations.map(
    (observation) => observation.latencyMs.firstTranslationTranscript,
  );
  const translationMinusSource = observations.map((observation) => {
    const sourceLatency = observation.latencyMs.firstSourceTranscript;
    const translationLatency = observation.latencyMs.firstTranslationTranscript;
    return sourceLatency === null || translationLatency === null
      ? null
      : translationLatency - sourceLatency;
  });
  const differenceSummary = summarizeLatencyValues(translationMinusSource);

  console.log(`\n[${caseId}] latency summary`);
  console.log(latencySummary("source first delta", source));
  console.log(latencySummary("translation first delta", translation));
  console.log(latencySummary("translation - source", translationMinusSource));
  if (differenceSummary.p50 !== null) {
    console.log(
      `median critical path: ${differenceSummary.p50 > 0
        ? "gpt-realtime-translate"
        : differenceSummary.p50 < 0
          ? "gpt-live-transcribe"
          : "tie"}`,
    );
  }
}

async function main() {
  const fixturePath = argument("--fixture") ?? process.env.REALTIME_SMOKE_FIXTURE;
  const selectedCase = argument("--case") ?? process.env.REALTIME_SMOKE_CASE;
  const repeat = positiveInteger(
    argument("--repeat") ?? process.env.REALTIME_SMOKE_REPEAT,
    "--repeat",
  );
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
    const observations: RealtimeSmokeObservation[] = [];
    for (let run = 1; run <= repeat; run += 1) {
      console.log(
        `\n[${smokeCase.id} ${run}/${repeat}] streaming ` +
          `${audio.durationMs.toFixed(0)}ms to Realtime API`,
      );
      const observation = await runRealtimeSmokeCase({
        smokeCase,
        audio,
        apiKey,
        model: process.env.OPENAI_REALTIME_TRANSLATION_MODEL,
        transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL,
        safetyIdentifier: process.env.OPENAI_SAFETY_IDENTIFIER,
      });
      observations.push(observation);
      const evaluation = evaluateRealtimeSmoke(smokeCase, observation);
      console.log(`source:      ${observation.sourceTranscript}`);
      console.log(`translation: ${observation.translationTranscript}`);
      for (const assertion of evaluation.assertions) {
        console.log(
          `${assertion.passed ? "PASS" : "FAIL"} ${assertion.name}: ${assertion.detail}`,
        );
      }
      console.log(
        `latency: source=${observation.latencyMs.firstSourceTranscript ?? "n/a"}ms, ` +
          `translation=${observation.latencyMs.firstTranslationTranscript ?? "n/a"}ms, ` +
          `audio=${observation.latencyMs.firstTranslatedAudio ?? "n/a"}ms, ` +
          `closed=${observation.latencyMs.sessionClosed}ms`,
      );
      console.log(
        `metrics: source ${evaluation.metrics.sourceMetric}=` +
          `${percentage(evaluation.metrics.sourceErrorRate)}, ` +
          `translation ${evaluation.metrics.translationMetric ?? "error"}=` +
          `${percentage(evaluation.metrics.translationErrorRate)}, ` +
          `terms=${percentage(evaluation.metrics.translationTermCoverage)}`,
      );
      failed ||= !evaluation.passed;
    }
    if (repeat > 1) printLatencySummary(smokeCase.id, observations);
  }
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
