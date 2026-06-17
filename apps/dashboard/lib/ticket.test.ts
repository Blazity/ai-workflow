import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSelectedRunId, mergeTicketLiveRuns } from "./ticket";
import type { Run, TicketRunsResponse } from "@shared/contracts";

function run(id: string): Run {
  return {
    id,
    workflow: "wf_agent",
    workflowName: "Agent",
    status: "success",
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
    ticketTitle: "t",
    prNumber: null,
    ticketUrl: "",
    prUrl: null,
  };
}

function mkRun(over: Partial<Run> & Pick<Run, "id">): Run {
  return { ...run(over.id), ...over };
}

function ticketData(runs: Run[]): TicketRunsResponse {
  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  for (const r of runs) counts[r.status]++;
  return {
    generatedAt: "t",
    available: true,
    ticket: { key: "AWT-9", title: "T", url: "" },
    runs,
    totals: {
      cost: runs.reduce((s, r) => s + (r.cost ?? 0), 0),
      tokens: runs.reduce((s, r) => s + (r.tokens ?? 0), 0),
      runCount: runs.length,
      counts,
    },
  };
}

test("returns requested id when it matches a run", () => {
  assert.equal(pickSelectedRunId([run("a"), run("b")], "b"), "b");
});

test("falls back to the first (newest) run when requested is missing/unknown", () => {
  assert.equal(pickSelectedRunId([run("a"), run("b")], undefined), "a");
  assert.equal(pickSelectedRunId([run("a"), run("b")], "zzz"), "a");
});

test("returns null when there are no runs", () => {
  assert.equal(pickSelectedRunId([], "a"), null);
});

test("mergeTicketLiveRuns surfaces a live running run missing from the store", () => {
  const data = ticketData([
    mkRun({ id: "done", status: "success", cost: 1.5, ticket: "AWT-9" }),
  ]);
  const live = [mkRun({ id: "live1", status: "running", ticket: "AWT-9" })];
  const merged = mergeTicketLiveRuns(data, live);
  assert.deepEqual(
    merged.runs.map((r) => r.id),
    ["live1", "done"],
  ); // live rows first (most recent activity)
  assert.equal(merged.totals.runCount, 2);
  assert.equal(merged.totals.counts.running, 1);
  assert.equal(merged.totals.counts.success, 1);
  assert.equal(merged.totals.cost, 1.5); // a running run has no cost yet
});

test("mergeTicketLiveRuns keeps the store authoritative once a run is terminal", () => {
  const data = ticketData([
    mkRun({ id: "r1", status: "success", cost: 2, ticket: "AWT-9" }),
  ]);
  // a lingering registry entry for an already-finished run must not mask it
  const live = [mkRun({ id: "r1", status: "running", ticket: "AWT-9" })];
  const merged = mergeTicketLiveRuns(data, live);
  assert.equal(merged.runs.length, 1);
  assert.equal(merged.runs[0].status, "success");
  assert.equal(merged.totals.counts.running, 0);
});

test("mergeTicketLiveRuns returns data unchanged when there are no live runs", () => {
  const data = ticketData([mkRun({ id: "r1", status: "success", ticket: "AWT-9" })]);
  assert.equal(mergeTicketLiveRuns(data, []), data);
});
