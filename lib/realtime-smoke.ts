import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import WebSocket, { type RawData } from "ws";

const OUTPUT_SAMPLE_RATE = 24_000;
const DEFAULT_CHUNK_MS = 100;
const DEFAULT_MAX_SOURCE_ERROR_RATE = 0.35;
const DEFAULT_MAX_TRANSLATION_ERROR_RATE = 0.65;

export type SmokeLanguage = "ja" | "en" | "mixed";

export type RealtimeSmokeCase = {
  id: string;
  audio: string;
  sourceLanguage: SmokeLanguage;
  targetLanguage: "ja" | "en";
  expectedSource: string;
  expectedTranslation?: string;
  requiredTranslationTerms?: Array<string | string[]>;
  expectAudio?: boolean;
  thresholds?: {
    maxSourceErrorRate?: number;
    maxTranslationErrorRate?: number;
    minTranslationTermCoverage?: number;
  };
};

export type RealtimeSmokeManifest = {
  version: 1;
  cases: RealtimeSmokeCase[];
};

export type PreparedAudio = {
  pcm16: Buffer;
  durationMs: number;
  originalSampleRate: number;
  originalChannels: number;
};

export type RealtimeSmokeObservation = {
  sourceTranscript: string;
  translationTranscript: string;
  translatedAudioBytes: number;
  durationMs: number;
  latencyMs: {
    firstSourceTranscript: number | null;
    firstTranslationTranscript: number | null;
    firstTranslatedAudio: number | null;
    sessionClosed: number;
  };
};

export type RealtimeSmokeEvaluation = {
  passed: boolean;
  assertions: Array<{ name: string; passed: boolean; detail: string }>;
  metrics: {
    sourceErrorRate: number;
    sourceMetric: "CER" | "WER";
    translationErrorRate: number | null;
    translationMetric: "CER" | "WER" | null;
    translationTermCoverage: number | null;
  };
};

export type LatencyPercentiles = {
  sampleCount: number;
  p50: number | null;
  p95: number | null;
};

export function summarizeLatencyValues(
  values: Array<number | null>,
): LatencyPercentiles {
  const sorted = values
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const percentile = (ratio: number) => {
    if (sorted.length === 0) return null;
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
  };

  return {
    sampleCount: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function optionalRate(value: unknown, field: string) {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a number between 0 and 1.`);
  }
}

export function validateRealtimeSmokeManifest(value: unknown): RealtimeSmokeManifest {
  if (!value || typeof value !== "object") throw new Error("Fixture must be an object.");
  const manifest = value as Partial<RealtimeSmokeManifest>;
  if (manifest.version !== 1) throw new Error("Fixture version must be 1.");
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error("Fixture cases must contain at least one case.");
  }

  const ids = new Set<string>();
  for (const [index, smokeCase] of manifest.cases.entries()) {
    if (!smokeCase || typeof smokeCase !== "object") {
      throw new Error(`cases[${index}] must be an object.`);
    }
    requireNonEmptyString(smokeCase.id, `cases[${index}].id`);
    if (ids.has(smokeCase.id)) throw new Error(`Duplicate case id: ${smokeCase.id}`);
    ids.add(smokeCase.id);
    requireNonEmptyString(smokeCase.audio, `cases[${index}].audio`);
    requireNonEmptyString(smokeCase.expectedSource, `cases[${index}].expectedSource`);
    if (!(["ja", "en", "mixed"] as const).includes(smokeCase.sourceLanguage)) {
      throw new Error(`cases[${index}].sourceLanguage must be ja, en, or mixed.`);
    }
    if (!(["ja", "en"] as const).includes(smokeCase.targetLanguage)) {
      throw new Error(`cases[${index}].targetLanguage must be ja or en.`);
    }
    if (smokeCase.expectedTranslation !== undefined) {
      requireNonEmptyString(
        smokeCase.expectedTranslation,
        `cases[${index}].expectedTranslation`,
      );
    }
    if (smokeCase.requiredTranslationTerms !== undefined) {
      if (
        !Array.isArray(smokeCase.requiredTranslationTerms) ||
        smokeCase.requiredTranslationTerms.length === 0
      ) {
        throw new Error(`cases[${index}].requiredTranslationTerms must not be empty.`);
      }
      for (const [termIndex, term] of smokeCase.requiredTranslationTerms.entries()) {
        const alternatives = Array.isArray(term) ? term : [term];
        if (alternatives.length === 0) {
          throw new Error(
            `cases[${index}].requiredTranslationTerms[${termIndex}] must not be empty.`,
          );
        }
        for (const alternative of alternatives) {
          requireNonEmptyString(
            alternative,
            `cases[${index}].requiredTranslationTerms[${termIndex}]`,
          );
        }
      }
    }
    optionalRate(
      smokeCase.thresholds?.maxSourceErrorRate,
      `cases[${index}].thresholds.maxSourceErrorRate`,
    );
    optionalRate(
      smokeCase.thresholds?.maxTranslationErrorRate,
      `cases[${index}].thresholds.maxTranslationErrorRate`,
    );
    optionalRate(
      smokeCase.thresholds?.minTranslationTermCoverage,
      `cases[${index}].thresholds.minTranslationTermCoverage`,
    );
  }
  return manifest as RealtimeSmokeManifest;
}

export async function loadRealtimeSmokeManifest(path: string) {
  const absolutePath = resolve(path);
  const manifest = validateRealtimeSmokeManifest(
    JSON.parse(await readFile(absolutePath, "utf8")) as unknown,
  );
  return {
    manifest,
    manifestPath: absolutePath,
    resolveAudioPath: (audio: string) => resolve(dirname(absolutePath), audio),
  };
}

function readFourCc(buffer: Buffer, offset: number) {
  return buffer.toString("ascii", offset, offset + 4);
}

export function prepareWavPcm16(buffer: Buffer): PreparedAudio {
  if (buffer.length < 44 || readFourCc(buffer, 0) !== "RIFF" || readFourCc(buffer, 8) !== "WAVE") {
    throw new Error("Audio must be a RIFF/WAVE file.");
  }

  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let data: Buffer | undefined;

  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const id = readFourCc(buffer, offset);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw new Error(`Invalid WAV chunk: ${id}`);
    if (id === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV fmt chunk.");
      audioFormat = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      data = buffer.subarray(start, end);
    }
    offset = end + (size % 2);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16) {
    throw new Error("WAV must use uncompressed 16-bit PCM audio.");
  }
  if (!channels || !sampleRate || !data) throw new Error("WAV is missing audio metadata or data.");
  if (data.length % (channels * 2) !== 0) throw new Error("WAV PCM data is not frame-aligned.");

  const inputFrames = data.length / (channels * 2);
  if (inputFrames === 0) throw new Error("WAV contains no audio samples.");
  const mono = new Float64Array(inputFrames);
  for (let frame = 0; frame < inputFrames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += data.readInt16LE((frame * channels + channel) * 2);
    }
    mono[frame] = sum / channels;
  }

  const outputFrames = Math.max(1, Math.round((inputFrames * OUTPUT_SAMPLE_RATE) / sampleRate));
  const pcm16 = Buffer.allocUnsafe(outputFrames * 2);
  for (let outputIndex = 0; outputIndex < outputFrames; outputIndex += 1) {
    const inputPosition = (outputIndex * sampleRate) / OUTPUT_SAMPLE_RATE;
    const leftIndex = Math.min(Math.floor(inputPosition), inputFrames - 1);
    const rightIndex = Math.min(leftIndex + 1, inputFrames - 1);
    const fraction = inputPosition - leftIndex;
    const sample = mono[leftIndex] + (mono[rightIndex] - mono[leftIndex]) * fraction;
    pcm16.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample))), outputIndex * 2);
  }

  return {
    pcm16,
    durationMs: (outputFrames / OUTPUT_SAMPLE_RATE) * 1_000,
    originalSampleRate: sampleRate,
    originalChannels: channels,
  };
}

function normalizeText(text: string) {
  return text.normalize("NFKC").toLocaleLowerCase();
}

function unitsForMetric(text: string, language: SmokeLanguage): string[] {
  const normalized = normalizeText(text);
  if (language === "en") {
    return normalized.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  }
  return [...normalized.replace(/[\p{P}\p{S}\s]/gu, "")];
}

function levenshtein(left: string[], right: string[]) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return previous[right.length];
}

export function transcriptErrorRate(actual: string, expected: string, language: SmokeLanguage) {
  const actualUnits = unitsForMetric(actual, language);
  const expectedUnits = unitsForMetric(expected, language);
  if (expectedUnits.length === 0) throw new Error("Expected transcript has no comparable text.");
  return levenshtein(expectedUnits, actualUnits) / expectedUnits.length;
}

function normalizeForTermSearch(text: string) {
  return normalizeText(text).replace(/[\p{P}\p{S}\s]/gu, "");
}

export function translationTermCoverage(
  actual: string,
  terms: Array<string | string[]>,
) {
  const haystack = normalizeForTermSearch(actual);
  const matched = terms.filter((term) => {
    const alternatives = Array.isArray(term) ? term : [term];
    return alternatives.some((alternative) =>
      haystack.includes(normalizeForTermSearch(alternative)),
    );
  }).length;
  return matched / terms.length;
}

export function evaluateRealtimeSmoke(
  smokeCase: RealtimeSmokeCase,
  observation: RealtimeSmokeObservation,
): RealtimeSmokeEvaluation {
  const sourceMetric = smokeCase.sourceLanguage === "en" ? "WER" : "CER";
  const sourceErrorRate = transcriptErrorRate(
    observation.sourceTranscript,
    smokeCase.expectedSource,
    smokeCase.sourceLanguage,
  );
  const translationMetric = smokeCase.expectedTranslation
    ? smokeCase.targetLanguage === "en" ? "WER" : "CER"
    : null;
  const translationErrorRate = smokeCase.expectedTranslation
    ? transcriptErrorRate(
        observation.translationTranscript,
        smokeCase.expectedTranslation,
        smokeCase.targetLanguage,
      )
    : null;
  const termCoverage = smokeCase.requiredTranslationTerms
    ? translationTermCoverage(
        observation.translationTranscript,
        smokeCase.requiredTranslationTerms,
      )
    : null;
  const assertions: RealtimeSmokeEvaluation["assertions"] = [];
  const add = (name: string, passed: boolean, detail: string) => {
    assertions.push({ name, passed, detail });
  };

  add(
    "source transcript",
    observation.sourceTranscript.trim().length > 0,
    observation.sourceTranscript || "(empty)",
  );
  add(
    `source ${sourceMetric}`,
    sourceErrorRate <= (smokeCase.thresholds?.maxSourceErrorRate ?? DEFAULT_MAX_SOURCE_ERROR_RATE),
    sourceErrorRate.toFixed(3),
  );
  add(
    "translation transcript",
    observation.translationTranscript.trim().length > 0,
    observation.translationTranscript || "(empty)",
  );
  if (translationErrorRate !== null && translationMetric) {
    add(
      `translation ${translationMetric}`,
      translationErrorRate <=
        (smokeCase.thresholds?.maxTranslationErrorRate ??
          DEFAULT_MAX_TRANSLATION_ERROR_RATE),
      translationErrorRate.toFixed(3),
    );
  }
  if (termCoverage !== null) {
    add(
      "translation term coverage",
      termCoverage >= (smokeCase.thresholds?.minTranslationTermCoverage ?? 1),
      termCoverage.toFixed(3),
    );
  }
  if (smokeCase.expectAudio !== false) {
    add(
      "translated audio",
      observation.translatedAudioBytes > 0,
      `${observation.translatedAudioBytes} bytes`,
    );
  }

  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    metrics: {
      sourceErrorRate,
      sourceMetric,
      translationErrorRate,
      translationMetric,
      translationTermCoverage: termCoverage,
    },
  };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function eventText(data: RawData) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

export async function runRealtimeSmokeCase(options: {
  smokeCase: RealtimeSmokeCase;
  audio: PreparedAudio;
  apiKey: string;
  model?: string;
  transcriptionModel?: string;
  safetyIdentifier?: string;
  timeoutMs?: number;
  chunkMs?: number;
}): Promise<RealtimeSmokeObservation> {
  const {
    smokeCase,
    audio,
    apiKey,
    model = "gpt-realtime-translate",
    transcriptionModel = "gpt-live-transcribe",
    safetyIdentifier = "xlator-realtime-smoke",
    timeoutMs = Math.max(30_000, audio.durationMs + 30_000),
    chunkMs = DEFAULT_CHUNK_MS,
  } = options;
  if (!apiKey.trim()) throw new Error("OPENAI_API_KEY is required.");

  const startedAt = performance.now();
  const latencyMs: RealtimeSmokeObservation["latencyMs"] = {
    firstSourceTranscript: null,
    firstTranslationTranscript: null,
    firstTranslatedAudio: null,
    sessionClosed: 0,
  };
  let sourceTranscript = "";
  let translationTranscript = "";
  let translatedAudioBytes = 0;

  return new Promise<RealtimeSmokeObservation>((resolveObservation, rejectObservation) => {
    const url = new URL("wss://api.openai.com/v1/realtime/translations");
    url.searchParams.set("model", model);
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Safety-Identifier": safetyIdentifier,
      },
    });
    let settled = false;
    const timeout = setTimeout(() => {
      socket.terminate();
      finish(new Error(`Realtime smoke test timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        rejectObservation(error);
        return;
      }
      latencyMs.sessionClosed = Math.round(performance.now() - startedAt);
      resolveObservation({
        sourceTranscript,
        translationTranscript,
        translatedAudioBytes,
        durationMs: audio.durationMs,
        latencyMs,
      });
    };

    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            input: {
              transcription: { model: transcriptionModel },
              noise_reduction: { type: "far_field" },
            },
            output: { language: smokeCase.targetLanguage },
          },
        },
      }));

      void (async () => {
        const bytesPerChunk = Math.round((OUTPUT_SAMPLE_RATE * 2 * chunkMs) / 1_000);
        for (let offset = 0; offset < audio.pcm16.length; offset += bytesPerChunk) {
          if (settled || socket.readyState !== WebSocket.OPEN) return;
          const chunk = audio.pcm16.subarray(offset, offset + bytesPerChunk);
          socket.send(JSON.stringify({
            type: "session.input_audio_buffer.append",
            audio: chunk.toString("base64"),
          }));
          await delay((chunk.length / (OUTPUT_SAMPLE_RATE * 2)) * 1_000);
        }
        if (!settled && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "session.close" }));
        }
      })().catch((error: unknown) => {
        socket.terminate();
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });

    socket.on("message", (data) => {
      let event: {
        type?: string;
        delta?: string;
        error?: { message?: string };
      };
      try {
        event = JSON.parse(eventText(data)) as typeof event;
      } catch {
        return;
      }
      const elapsed = Math.round(performance.now() - startedAt);
      if (event.type === "session.input_transcript.delta" && event.delta) {
        if (latencyMs.firstSourceTranscript === null) latencyMs.firstSourceTranscript = elapsed;
        sourceTranscript += event.delta;
      } else if (event.type === "session.output_transcript.delta" && event.delta) {
        if (latencyMs.firstTranslationTranscript === null) {
          latencyMs.firstTranslationTranscript = elapsed;
        }
        translationTranscript += event.delta;
      } else if (event.type === "session.output_audio.delta" && event.delta) {
        if (latencyMs.firstTranslatedAudio === null) latencyMs.firstTranslatedAudio = elapsed;
        translatedAudioBytes += Buffer.byteLength(event.delta, "base64");
      } else if (event.type === "session.closed") {
        socket.close();
        finish();
      } else if (event.type === "error") {
        socket.terminate();
        finish(new Error(event.error?.message ?? "Realtime API returned an error."));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error("Realtime socket closed before session.closed."));
    });
  });
}
