import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSelectedRunId } from "./ticket";
import type { Run } from "@shared/contracts";

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
