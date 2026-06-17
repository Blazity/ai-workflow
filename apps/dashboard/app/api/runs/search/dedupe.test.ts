import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeHitsByTicket } from "./dedupe";
import type { Run } from "@shared/contracts";

function run(over: Partial<Run> & Pick<Run, "id">): Run {
  return {
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
    ...over,
  };
}

test("collapses multiple runs of one ticket into a single hit with a count", () => {
  const hits = dedupeHitsByTicket([
    run({ id: "a", ticket: "AWT-9" }),
    run({ id: "b", ticket: "AWT-9" }),
    run({ id: "c", ticket: "AWT-10" }),
  ]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "a"); // keeps the first (newest) row
  assert.equal(hits[0].runCount, 2);
  assert.equal(hits[1].id, "c");
  assert.equal(hits[1].runCount, 1);
});

test("keeps ticketless rows individual", () => {
  const hits = dedupeHitsByTicket([
    run({ id: "a", ticket: "" }),
    run({ id: "b", ticket: "" }),
  ]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].runCount, 1);
  assert.equal(hits[1].runCount, 1);
});
