import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeLiveRuns } from "./merge-live-runs";
import type { Run, RunsResponse, LiveRunsResponse } from "@shared/contracts";

function run(over: Partial<Run> & Pick<Run, "id" | "status">): Run {
  return {
    workflow: "wf_agent",
    workflowName: "Agent",
    ticket: "AWT-1",
    actor: "ai-bot",
    model: "claude",
    startedAtMin: 0,
    duration: null,
    tokens: null,
    cost: null,
    spans: null,
    evalScore: null,
    guardrailHits: null,
    ticketTitle: "AWT-1",
    prNumber: null,
    ticketUrl: "",
    prUrl: null,
    prs: null,
    ...over,
  };
}

function runsResponse(rows: Run[]): RunsResponse {
  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  for (const r of rows) counts[r.status]++;
  return { generatedAt: "t", available: true, rows, total: rows.length, counts };
}

const liveResponse = (rows: Run[]): LiveRunsResponse => ({ generatedAt: "t", rows });

test("a run that already succeeded in the store is not masked as running by a lingering live entry", () => {
  // Store (authoritative) recorded the run as success...
  const runs = runsResponse([
    run({ id: "run_done", status: "success", ticket: "AWT-1" }),
  ]);
  // ...but the run-registry entry still exists, so the live overlay reports it "running".
  const live = liveResponse([
    run({ id: "run_done", status: "running", ticket: "AWT-1" }),
  ]);

  const merged = mergeLiveRuns(runs, live);
  const row = merged.rows.find((r) => r.id === "run_done");

  assert.equal(row?.status, "success", "the store's terminal status must win over the live overlay");
  assert.equal(merged.counts.running, 0);
  assert.equal(merged.counts.success, 1);
  assert.equal(merged.rows.length, 1, "no duplicate row for the same run id");
});

test("a genuinely in-flight run (no terminal store row) still shows as running", () => {
  const runs = runsResponse([]);
  const live = liveResponse([
    run({ id: "run_inflight", status: "running", ticket: "AWT-2" }),
  ]);

  const merged = mergeLiveRuns(runs, live);
  assert.equal(merged.rows.find((r) => r.id === "run_inflight")?.status, "running");
  assert.equal(merged.counts.running, 1);
});

test("an awaiting live run with no store row is preserved", () => {
  const runs = runsResponse([]);
  const live = liveResponse([
    run({ id: "run_awaiting", status: "awaiting", ticket: "AWT-3" }),
  ]);

  const merged = mergeLiveRuns(runs, live);
  assert.equal(merged.rows.find((r) => r.id === "run_awaiting")?.status, "awaiting");
  assert.equal(merged.counts.awaiting, 1);
});

test("an awaiting live row with a real run id overrides the bare store copy", () => {
  // The durable store row for a parked run carries status "awaiting" but no
  // question payload; the live row (same real run id) adds the enriched question.
  const runs = runsResponse([
    run({ id: "run_await", status: "awaiting", ticket: "AWT-9" }),
  ]);
  const live = liveResponse([
    run({
      id: "run_await",
      status: "awaiting",
      ticket: "AWT-9",
      question: "1. Which environment?",
    }),
  ]);

  const merged = mergeLiveRuns(runs, live);
  const row = merged.rows.find((r) => r.id === "run_await");
  assert.equal(row?.question, "1. Which environment?", "the enriched live row wins");
  assert.equal(merged.rows.length, 1, "no duplicate row for the same run id");
  assert.equal(merged.counts.awaiting, 1);
});

// Red when: the merge recounts only the rows it holds. The worker's list stops
// at a page of rows but its total and counts cover the whole window, and that
// complete count is the one the Overview's KPI tile makes too; dropping it put
// two different numbers for one window on two screens.
test("the merged total keeps the store's complete count and adds only the runs the live board brought", () => {
  const stored = [run({ id: "run_a", status: "success" }), run({ id: "run_b", status: "awaiting" })];
  const runs = runsResponse(stored);
  runs.total = 700;
  runs.counts = { success: 640, running: 0, awaiting: 1, failed: 59, blocked: 0 };
  const live = liveResponse([
    // The store's own parked row, enriched: replaces it, adds nothing.
    run({ id: "run_b", status: "awaiting", question: "Which one?" }),
    // A run parked days ago, outside the window the store listed.
    run({ id: "run_old", status: "awaiting", startedAtMin: 6998 }),
  ]);

  const merged = mergeLiveRuns(runs, live);
  assert.equal(merged.rows.length, 3);
  assert.equal(merged.total, 701);
  assert.deepEqual(merged.counts, { success: 640, running: 0, awaiting: 2, failed: 59, blocked: 0 });
});

test("a live row that changes a stored run's status moves it between counts, not into a second one", () => {
  const runs = runsResponse([run({ id: "run_park", status: "running" })]);
  const merged = mergeLiveRuns(runs, liveResponse([run({ id: "run_park", status: "awaiting" })]));
  assert.equal(merged.total, 1);
  assert.equal(merged.counts.running, 0);
  assert.equal(merged.counts.awaiting, 1);
});
