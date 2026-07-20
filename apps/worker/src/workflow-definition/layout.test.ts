import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@shared/contracts";
import {
  applyWorkflowDefinitionLayout,
  canonicalizeWorkflowDefinition,
  extractWorkflowDefinitionLayout,
} from "./layout.js";

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  nodes: [
    { id: "a", type: "trigger_ticket_ai", x: 12, y: 34, params: {}, inputs: {} },
  ],
  edges: [],
};

describe("workflow definition layout", () => {
  it("round-trips coordinates outside the semantic graph", () => {
    const layout = extractWorkflowDefinitionLayout(definition);
    const semantic = canonicalizeWorkflowDefinition(definition);

    expect(semantic.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(applyWorkflowDefinitionLayout(semantic, layout)).toEqual(definition);
  });
});
