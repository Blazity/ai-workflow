import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_EDGES, MAX_NODES } from "./limits";
import { workflowDefinitionV2Schema } from "./schema";

function definitionWith(nodeCount: number, edgeCount: number): unknown {
  return {
    schemaVersion: 2,
    nodes: Array.from({ length: nodeCount }, (_unused, index) => ({
      id: `n${index}`,
      type: "terminate",
      x: 0,
      y: 0,
      configuration: { terminalStatus: "done" },
      inputs: {},
      additionalInputs: [],
    })),
    edges: Array.from({ length: edgeCount }, (_unused, index) => ({
      id: `e${index}`,
      from: "n0",
      to: "n1",
    })),
  };
}

test("the limits are the numbers the parser enforces", () => {
  assert.equal(MAX_NODES, 200);
  assert.equal(MAX_EDGES, 400);
});

test("a definition at the limits parses", () => {
  assert.equal(
    workflowDefinitionV2Schema.safeParse(definitionWith(MAX_NODES, MAX_EDGES))
      .success,
    true,
  );
});

test("one block over the limit is refused by message", () => {
  const parsed = workflowDefinitionV2Schema.safeParse(
    definitionWith(MAX_NODES + 1, 0),
  );
  assert.equal(parsed.success, false);
  assert.equal(
    parsed.error?.issues.some(
      (issue) => issue.message === `Workflow cannot have more than ${MAX_NODES} blocks.`,
    ),
    true,
  );
});

test("one connection over the limit is refused by message", () => {
  const parsed = workflowDefinitionV2Schema.safeParse(
    definitionWith(2, MAX_EDGES + 1),
  );
  assert.equal(parsed.success, false);
  assert.equal(
    parsed.error?.issues.some(
      (issue) =>
        issue.message === `Workflow cannot have more than ${MAX_EDGES} connections.`,
    ),
    true,
  );
});
