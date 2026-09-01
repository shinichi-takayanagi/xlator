export type BrowserLatencyMetric =
  | "speech-to-source-display"
  | "speech-to-translation-display"
  | "silence-to-row-final";

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
  return {
    sequence,
    metric,
    durationMs: Math.max(0, Math.round(endedAt - startedAt)),
  };
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
  const measurement = createBrowserLatencyMeasurement(
    sequence,
    metric,
    startedAt,
    endedAt,
  );
  const latencyWindow = window as LatencyWindow;
  latencyWindow.__xlatorLatency ??= [];
  latencyWindow.__xlatorLatency.push(measurement);
  window.dispatchEvent(new CustomEvent("xlator:latency", { detail: measurement }));
  console.info("[xlator:latency]", measurement);
  return measurement;
}
