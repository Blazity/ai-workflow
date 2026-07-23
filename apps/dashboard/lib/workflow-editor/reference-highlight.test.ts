import assert from "node:assert/strict";
import test from "node:test";
import type { FlowNodeDef } from "@/lib/flows";
import { sourceNodeIdsForReference } from "./reference-highlight.ts";

const nodes: FlowNodeDef[] = [
  {
    id: "trigger",
    type: "trigger_ticket_ai",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
  },
  {
    id: "plan",
    type: "planning_agent",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
  },
];

test("canonical references resolve their producing node", () => {
  assert.deepEqual(
    sourceNodeIdsForReference(
      "{{data:steps.plan.output.summary}} and steps.plan.output.details",
      nodes,
    ),
    ["plan"],
  );
});

test("the virtual entry source highlights the active trigger node", () => {
  assert.deepEqual(
    sourceNodeIdsForReference("steps.entry.output.ticket.key", nodes),
    ["trigger"],
  );
});

test("run values, literals, and unknown nodes do not produce highlights", () => {
  assert.deepEqual(
    sourceNodeIdsForReference(
      "run.id {{data:steps.unknown.output.value}} literal.steps.plan.other",
      nodes,
    ),
    [],
  );
});
