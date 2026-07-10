import { describe, expect, it } from "vitest";
import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import { defaultOrderedBlocks, defaultWorkflowDefinition } from "./default.js";
import { orderBlocks } from "./plan.js";
import { validateWorkflowGraph, workflowDefinitionSchema } from "./schema.js";

function node(id: string, type: WorkflowBlockType): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params: {} };
}

function graph(
  nodes: WorkflowDefinitionNode[],
  edges: WorkflowDefinitionEdge[],
): WorkflowDefinition {
  return { schemaVersion: 1, nodes, edges };
}

describe("orderBlocks", () => {
  it("linearizes the default with review, excluding the trigger", () => {
    const def = defaultWorkflowDefinition({ includeReview: true });
    expect(orderBlocks(def).map((block) => block.type)).toEqual([
      "planning_agent",
      "implementation_agent",
      "review_agent",
      "run_pre_pr_checks",
      "open_pr",
      "send_slack_message",
      "update_ticket_status",
    ]);
  });

  it("linearizes the default without review, excluding the trigger", () => {
    expect(defaultOrderedBlocks({ includeReview: false }).map((block) => block.type)).toEqual([
      "planning_agent",
      "implementation_agent",
      "run_pre_pr_checks",
      "open_pr",
      "send_slack_message",
      "update_ticket_status",
    ]);
  });

  it("terminates on a cycle and returns each block once", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("implementation", "implementation_agent"),
      ],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "implementation" },
        { from: "implementation", to: "planning" },
      ],
    );
    expect(orderBlocks(def).map((block) => block.id)).toEqual(["planning", "implementation"]);
  });

  it("stops the walk at an edge pointing to a missing node", () => {
    const def = graph(
      [node("trigger", "trigger_ticket_ai"), node("planning", "planning_agent")],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "ghost" },
      ],
    );
    expect(orderBlocks(def).map((block) => block.id)).toEqual(["planning"]);
  });
});

describe("defaultWorkflowDefinition", () => {
  it("passes the schema and graph validation for both review options", () => {
    for (const includeReview of [true, false]) {
      const def = defaultWorkflowDefinition({ includeReview });
      expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
      expect(validateWorkflowGraph(def)).toEqual([]);
    }
  });
});
