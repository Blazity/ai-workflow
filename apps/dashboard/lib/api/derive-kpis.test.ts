import assert from "node:assert/strict";
import test from "node:test";

import type { Run, RunsResponse } from "@shared/contracts";

import { deriveKpisFromRuns } from "./derive-kpis";

function run(status: Run["status"], duration: number, startedAtMin: number): Run {
  return { id: `run_${status}_${duration}`, status, duration, startedAtMin } as Run;
}

function runsList(rows: Run[]): RunsResponse {
  return {
    generatedAt: "2026-09-25T08:00:00.000Z",
    available: true,
    rows,
    total: rows.length,
    counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
  };
}

// The worker's tile is the p95 of successful runs, and the Overview falls back
// to this derivation whenever the worker's tile is null, which is exactly what
// the worker answers for a window without a successful run. A fallback that
// took every duration would put a number back on that tile.
// Red when: the fallback reads failed runs' durations, or reads no run as 0 s.
test("the fallback p95 has no value when no run in the window succeeded", () => {
  const kpis = deriveKpisFromRuns(
    runsList([run("failed", 53, 30), run("failed", 32, 90), run("success", 544, 30 * 60)]),
    "2026-09-25T08:00:00.000Z",
  );
  assert.equal(kpis.runs24h?.value, 2, "the window's runs were read");
  assert.equal(kpis.p95, null);
});

test("the fallback p95 is taken over successful runs only", () => {
  const kpis = deriveKpisFromRuns(
    runsList([run("success", 60, 30), run("failed", 500, 45)]),
    "2026-09-25T08:00:00.000Z",
  );
  assert.equal(kpis.p95?.valueSec, 60);
  assert.equal(kpis.p95?.deltaSec, 0, "no previous successful run, nothing to compare with");
});
