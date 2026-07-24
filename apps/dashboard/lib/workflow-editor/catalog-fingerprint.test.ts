import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowDefinitionV2 } from "@shared/contracts";
import { workflowCatalogFingerprint } from "./catalog-fingerprint.ts";

const definition: WorkflowDefinitionV2 = {
  schemaVersion: 2,
  nodes: [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      x: 10,
      y: 20,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
    {
      id: "message",
      type: "post_ticket_comment",
      x: 200,
      y: 20,
      configuration: { body: "Initial prose" },
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [{ id: "edge", from: "trigger", to: "message" }],
};

test("catalog fingerprint ignores layout and ordinary prose", () => {
  const changed = structuredClone(definition);
  changed.nodes[1]!.x = 500;
  changed.nodes[1]!.y = 700;
  changed.nodes[1]!.configuration.body = "Edited prose";

  assert.equal(
    workflowCatalogFingerprint(changed),
    workflowCatalogFingerprint(definition),
  );
});

test("catalog fingerprint changes for graph and contract configuration", () => {
  const graph = structuredClone(definition);
  graph.edges[0]!.fromPort = "true";
  assert.notEqual(
    workflowCatalogFingerprint(graph),
    workflowCatalogFingerprint(definition),
  );

  const schema = structuredClone(definition);
  schema.nodes[1]!.additionalInputs.push({
    name: "score",
    schema: { type: "number" },
    binding: { kind: "literal", value: 1 },
  });
  assert.notEqual(
    workflowCatalogFingerprint(schema),
    workflowCatalogFingerprint(definition),
  );
});
