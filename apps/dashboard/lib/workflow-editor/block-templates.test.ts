import assert from "node:assert/strict";
import test from "node:test";
import { instantiateWorkflowEditorBlockTemplate } from "./block-templates";

test("Review with decision creates a visible editable Branch using generated ids", () => {
  const result = instantiateWorkflowEditorBlockTemplate({
    templateId: "review-with-decision",
    sourceName: "Review agent",
    sourceParams: { model: "claude-test" },
    position: { x: 100, y: 200 },
    existingNodes: [{ id: "review" }, { id: "review-decision" }],
    existingEdges: [{ id: "edge-existing" }],
    generateEdgeId: () => "edge-review-2",
  });

  assert.equal(result.nodes[0].id, "review-2");
  assert.equal(result.nodes[1].id, "review-decision-2");
  assert.equal(result.nodes[1].type, "branch");
  assert.equal(result.nodes[1].name, "Review approved?");
  assert.deepEqual(result.nodes[1].v2?.configuration, {
    condition: {
      kind: "eq",
      left: {
        kind: "path",
        reference: "steps.review-2.output.decision",
      },
      right: { kind: "lit", value: "approve" },
    },
  });
  assert.deepEqual(result.edges, [
    {
      id: "edge-review-2",
      from: "review-2",
      to: "review-decision-2",
    },
  ]);
  assert.equal(result.selectedNodeId, "review-decision-2");
});

test("Checks with result branches on the typed passed outcome", () => {
  const result = instantiateWorkflowEditorBlockTemplate({
    templateId: "checks-with-result",
    sourceName: "Run checks",
    sourceParams: { commands: ["pnpm test"] },
    position: { x: 20, y: 40 },
    existingNodes: [],
    existingEdges: [],
    generateEdgeId: () => "edge-checks",
  });

  assert.deepEqual(result.nodes.map(({ id, type, x, y }) => ({ id, type, x, y })), [
    { id: "checks", type: "run_checks", x: 20, y: 40 },
    { id: "checks-result", type: "branch", x: 290, y: 40 },
  ]);
  assert.deepEqual(result.nodes[1].v2?.configuration, {
    condition: {
      kind: "eq",
      left: {
        kind: "path",
        reference: "steps.checks.output.outcome",
      },
      right: { kind: "lit", value: "passed" },
    },
  });
});

test("edge generation retries collisions", () => {
  const generated = ["edge-used", "edge-fresh"];
  const result = instantiateWorkflowEditorBlockTemplate({
    templateId: "checks-with-result",
    sourceName: "Run checks",
    sourceParams: {},
    position: { x: 0, y: 0 },
    existingNodes: [],
    existingEdges: [{ id: "edge-used" }],
    generateEdgeId: () => generated.shift() ?? "unexpected",
  });
  assert.equal(result.edges[0].id, "edge-fresh");
});
