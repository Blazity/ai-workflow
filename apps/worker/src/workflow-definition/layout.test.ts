import { describe, expect, it } from "vitest";
import type { WorkflowDefinitionV2 } from "@shared/contracts";
import { normalizeWorkflowDefinitionLayout } from "@shared/contracts";
import {
  applyWorkflowDefinitionLayout,
  canonicalizeWorkflowDefinition,
  extractWorkflowDefinitionLayout,
} from "./layout.js";

describe("workflow definition layout", () => {
  it("round-trips v2 layout without rewriting configuration or bindings", () => {
    const v2: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [
        {
          id: "entry-trigger",
          type: "trigger_ticket_ai",
          x: 44,
          y: 55,
          configuration: { scope: "workflow_owned" },
          inputs: {
            title: { kind: "reference", reference: "steps.entry.output.title" },
          },
          additionalInputs: [],
        },
      ],
      edges: [],
    };

    const layout = extractWorkflowDefinitionLayout(v2);
    const semantic = canonicalizeWorkflowDefinition(v2);
    expect(semantic.nodes[0]).toMatchObject({
      x: 0,
      y: 0,
      configuration: { scope: "workflow_owned" },
    });
    expect(applyWorkflowDefinitionLayout(semantic, layout)).toEqual(v2);
  });

  it("normalizes legacy node-only layout JSON without rewriting coordinates", () => {
    expect(
      normalizeWorkflowDefinitionLayout({
        nodes: { a: { x: 12, y: 34 } },
      }),
    ).toEqual({
      nodes: { a: { x: 12, y: 34 } },
      edges: {},
    });
  });
});
