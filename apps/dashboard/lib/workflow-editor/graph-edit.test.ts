import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowEdgeDef, FlowNodeDef } from "../flows.ts";
import { removeNodeFromGraph } from "./graph-edit.ts";

const nodes: FlowNodeDef[] = [
  { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
  { id: "agent", type: "implementation_agent", x: 1, y: 0, params: {}, inputs: {} },
  { id: "done", type: "open_pr", x: 2, y: 0, params: {}, inputs: {} },
];
const edges: FlowEdgeDef[] = [
  { from: "trigger", to: "agent" },
  { from: "agent", to: "done" },
];

test("node deletion removes the block and all incident connections", () => {
  const result = removeNodeFromGraph(nodes, edges, "agent");
  assert.deepEqual(result.nodes.map((node) => node.id), ["trigger", "done"]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.removed, true);
});

test("the sole trigger remains protected from context-menu deletion", () => {
  const result = removeNodeFromGraph(nodes, edges, "trigger");
  assert.equal(result.nodes, nodes);
  assert.equal(result.edges, edges);
  assert.equal(result.removed, false);
});
