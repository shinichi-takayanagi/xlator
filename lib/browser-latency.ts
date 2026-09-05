import type { Language, Utterance } from "./translation-types";
import type { TranscriptCommit, TranscriptKind } from "./transcript-display";

export type BrowserLatencyMetric =
  | "speech-to-source-receipt"
  | "speech-to-translation-receipt"
  | "source-receipt-to-adoption"
  | "translation-receipt-to-adoption"
  | "source-adoption-to-dom"
  | "translation-adoption-to-dom"
  | "speech-to-source-dom"
  | "speech-to-translation-dom"
  | "silence-to-speech-end"
  | "silence-to-source-completed"
  | "source-completed-to-dom";

export type BrowserLatencyMeasurement = {
  sequence: number;
  metric: BrowserLatencyMetric;
  durationMs: number;
};

type LatencyWindow = Window & {
  __xlatorLatency?: BrowserLatencyMeasurement[];
};

export function createBrowserLatencyMeasurement(
  sequence: number,
  metric: BrowserLatencyMetric,
  startedAt: number,
  endedAt: number,
): BrowserLatencyMeasurement {
  return { sequence, metric, durationMs: Math.max(0, Math.round(endedAt - startedAt)) };
}

export function resetBrowserLatencyMeasurements() {
  (window as LatencyWindow).__xlatorLatency = [];
}

export function recordBrowserLatency(
  sequence: number,
  metric: BrowserLatencyMetric,
  startedAt: number,
  endedAt = performance.now(),
) {
  const measurement = createBrowserLatencyMeasurement(sequence, metric, startedAt, endedAt);
  const latencyWindow = window as LatencyWindow;
  latencyWindow.__xlatorLatency ??= [];
  latencyWindow.__xlatorLatency.push(measurement);
  window.dispatchEvent(new CustomEvent("xlator:latency", { detail: measurement }));
  console.info("[xlator:latency]", measurement);
  return measurement;
}

type RowTiming = {
  speech?: number;
  silence?: number;
  sourceReceipt?: number;
  completed?: number;
  translationReceipt: Partial<Record<Language, number>>;
  adopted: Partial<Record<TranscriptKind, number>>;
  measured: Set<BrowserLatencyMetric>;
};
type RowIdentity = Pick<Utterance, "id" | "sequence">;
type Recorder = (sequence: number, metric: BrowserLatencyMetric, start: number, end: number) => unknown;

export function createTranscriptLatencyTracker(record: Recorder = recordBrowserLatency) {
  const timings = new Map<string, RowTiming>();
  const timingFor = (id: string) => {
    let timing = timings.get(id);
    if (!timing) {
      timing = { translationReceipt: {}, adopted: {}, measured: new Set() };
      timings.set(id, timing);
    }
    return timing;
  };
  const emit = (row: RowIdentity, metric: BrowserLatencyMetric, start: number | undefined, end: number) => {
    const timing = timingFor(row.id);
    // Missing VAD timestamps and events from before this speech are not zero-latency samples.
    if (start === undefined || end < start || timing.measured.has(metric)) return;
    timing.measured.add(metric);
    record(row.sequence, metric, start, end);
  };
  return {
    reset: () => timings.clear(),
    discard: (id: string) => timings.delete(id),
    speechStarted(id: string, at: number) { timingFor(id).speech ??= at; },
    sourceReceived(row: RowIdentity, at: number, completed: boolean) {
      const timing = timingFor(row.id);
      timing.sourceReceipt ??= at;
      emit(row, "speech-to-source-receipt", timing.speech, timing.sourceReceipt);
      if (completed) {
        timing.completed ??= at;
        emit(row, "silence-to-source-completed", timing.silence, timing.completed);
      }
    },
    translationReceived(rowId: string, language: Language, at: number) {
      timingFor(rowId).translationReceipt[language] ??= at;
    },
    speechEnded(row: RowIdentity, silenceAt: number, at: number) {
      const timing = timingFor(row.id);
      timing.silence = silenceAt;
      emit(row, "silence-to-speech-end", silenceAt, at);
      if (timing.completed !== undefined) {
        emit(row, "silence-to-source-completed", silenceAt, timing.completed);
      }
    },
    adopted(row: RowIdentity, kind: TranscriptKind, language: Language, at: number) {
      const timing = timingFor(row.id);
      if (timing.adopted[kind] !== undefined) return;
      timing.adopted[kind] = at;
      const receipt = kind === "source" ? timing.sourceReceipt : timing.translationReceipt[language];
      if (kind === "translation" && receipt !== undefined) {
        emit(row, "speech-to-translation-receipt", timing.speech, receipt);
      }
      emit(row, `${kind}-receipt-to-adoption`, receipt, at);
    },
    domCommitted(commit: TranscriptCommit, at: number) {
      const row = { id: commit.rowId, sequence: commit.sequence };
      const timing = timings.get(row.id);
      if (!timing) return;
      emit(row, `${commit.kind}-adoption-to-dom`, timing.adopted[commit.kind], at);
      emit(row, `speech-to-${commit.kind}-dom`, timing.speech, at);
      if (commit.kind === "source" && commit.sourceFinal) {
        emit(row, "source-completed-to-dom", timing.completed, at);
      }
    },
  };
}
