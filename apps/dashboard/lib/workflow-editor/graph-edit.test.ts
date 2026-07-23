import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowEdgeDef, FlowNodeDef } from "../flows.ts";
import {
  removeNodeFromGraph,
  removeSelectionFromGraph,
} from "./graph-edit.ts";

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

test("multi-delete removes selected nodes, incident edges, and selected standalone edges", () => {
  const graphNodes: FlowNodeDef[] = [
    ...nodes,
    {
      id: "other",
      type: "post_ticket_comment",
      x: 3,
      y: 0,
      params: {},
      inputs: {},
    },
  ];
  const graphEdges: FlowEdgeDef[] = [
    { id: "trigger-agent", from: "trigger", to: "agent" },
    { id: "agent-done", from: "agent", to: "done" },
    { id: "trigger-other", from: "trigger", to: "other" },
  ];

  const result = removeSelectionFromGraph(graphNodes, graphEdges, {
    nodeIds: ["agent"],
    edgeKeys: ["trigger-other"],
  });

  assert.equal(result.removed, true);
  assert.equal(result.blocker, null);
  assert.deepEqual(
    result.nodes.map((node) => node.id),
    ["trigger", "done", "other"],
  );
  assert.deepEqual(result.edges, []);
});

test("multi-delete is atomic when the selection contains every trigger", () => {
  const secondTrigger: FlowNodeDef = {
    id: "manual",
    type: "trigger_plan_approved",
    x: 0,
    y: 1,
    params: {},
    inputs: {},
  };
  const graphNodes = [...nodes, secondTrigger];
  const result = removeSelectionFromGraph(graphNodes, edges, {
    nodeIds: ["trigger", "manual", "agent"],
    edgeKeys: [],
  });

  assert.equal(result.removed, false);
  assert.equal(result.blocker, "trigger_required");
  assert.equal(result.nodes, graphNodes);
  assert.equal(result.edges, edges);
});

test("multi-delete allows one of multiple triggers to be removed", () => {
  const secondTrigger: FlowNodeDef = {
    id: "manual",
    type: "trigger_plan_approved",
    x: 0,
    y: 1,
    params: {},
    inputs: {},
  };
  const result = removeSelectionFromGraph(
    [...nodes, secondTrigger],
    edges,
    {
      nodeIds: ["trigger"],
      edgeKeys: [],
    },
  );

  assert.equal(result.removed, true);
  assert.equal(result.blocker, null);
  assert.deepEqual(
    result.nodes.map((node) => node.id),
    ["agent", "done", "manual"],
  );
  assert.deepEqual(result.edges, [{ from: "agent", to: "done" }]);
});

test("unknown selection entries are a no-op and retain array identity", () => {
  const result = removeSelectionFromGraph(nodes, edges, {
    nodeIds: ["missing"],
    edgeKeys: ["missing-edge"],
  });

  assert.equal(result.removed, false);
  assert.equal(result.blocker, null);
  assert.equal(result.nodes, nodes);
  assert.equal(result.edges, edges);
});

test("a pre-existing triggerless draft can still remove non-trigger blocks", () => {
  const triggerless = nodes.filter((node) => node.id !== "trigger");
  const result = removeSelectionFromGraph(triggerless, edges, {
    nodeIds: ["agent"],
    edgeKeys: [],
  });

  assert.equal(result.removed, true);
  assert.equal(result.blocker, null);
  assert.deepEqual(
    result.nodes.map((node) => node.id),
    ["done"],
  );
});
