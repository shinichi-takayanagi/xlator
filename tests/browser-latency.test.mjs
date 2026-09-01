import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserLatencyMeasurement } from "../lib/browser-latency.ts";

test("creates a rounded non-negative browser latency measurement", () => {
  assert.deepEqual(
    createBrowserLatencyMeasurement(2, "speech-to-source-display", 100.2, 215.8),
    {
      sequence: 2,
      metric: "speech-to-source-display",
      durationMs: 116,
    },
  );
  assert.equal(
    createBrowserLatencyMeasurement(2, "silence-to-row-final", 200, 190).durationMs,
    0,
  );
});
