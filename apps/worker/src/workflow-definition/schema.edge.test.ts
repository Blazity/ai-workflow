import { describe, expect, it } from "vitest";
import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import { validateWorkflowGraph, workflowDefinitionSchema } from "./schema.js";

// Helpers copied verbatim from schema.test.ts.
function node(
  id: string,
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue> = {},
): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params, inputs: {} };
}

function graph(
  nodes: WorkflowDefinitionNode[],
  edges: WorkflowDefinitionEdge[],
): WorkflowDefinition {
  return { schemaVersion: 1, nodes, edges };
}

function shapeOk(nodes: unknown[], edges: unknown[] = []): boolean {
  return workflowDefinitionSchema.safeParse({ schemaVersion: 1, nodes, edges }).success;
}

describe("workflowDefinitionSchema edge cases (ZOD shape)", () => {
  it("rejects a definition missing schemaVersion entirely", () => {
    expect(workflowDefinitionSchema.safeParse({ nodes: [], edges: [] }).success).toBe(false);
  });

  it("rejects an unknown top-level key on the definition object", () => {
    expect(
      workflowDefinitionSchema.safeParse({ schemaVersion: 1, nodes: [], edges: [], bogus: 1 }).success,
    ).toBe(false);
  });

  it("rejects nodes/edges that are not arrays", () => {
    expect(
      workflowDefinitionSchema.safeParse({ schemaVersion: 1, nodes: {}, edges: 0 }).success,
    ).toBe(false);
  });

  it("rejects a node-level unknown key outside params", () => {
    expect(shapeOk([{ id: "n", type: "open_pr", x: 0, y: 0, params: {}, foo: 1 }])).toBe(false);
  });

  it("rejects a branch missing its required condition", () => {
    expect(shapeOk([node("n", "branch", {})])).toBe(false);
  });

  it("rejects a loop missing its required maxAttempts", () => {
    expect(shapeOk([node("l", "loop", { onExhaust: "fail" })])).toBe(false);
  });

  it("rejects a terminate missing its required terminalStatus", () => {
    expect(shapeOk([node("x", "terminate", {})])).toBe(false);
  });

  it("rejects update_ticket_status missing its required target", () => {
    expect(shapeOk([node("n", "update_ticket_status", {})])).toBe(false);
  });

  it("rejects call_llm missing its required prompt", () => {
    expect(shapeOk([node("n", "call_llm", {})])).toBe(false);
  });

  it("rejects an edge missing 'from'", () => {
    const nodes = [node("t", "trigger_ticket_ai"), node("p", "planning_agent")];
    expect(shapeOk(nodes, [{ to: "p" }])).toBe(false);
  });

  it("rejects an edge missing 'to'", () => {
    const nodes = [node("t", "trigger_ticket_ai"), node("p", "planning_agent")];
    expect(shapeOk(nodes, [{ from: "t" }])).toBe(false);
  });

  it("rejects an edge with an unknown key", () => {
    const nodes = [node("t", "trigger_ticket_ai"), node("p", "planning_agent")];
    expect(shapeOk(nodes, [{ from: "t", to: "p", bogus: 1 }])).toBe(false);
  });

  it("rejects a blank/whitespace node id", () => {
    expect(shapeOk([{ id: "  ", type: "open_pr", x: 0, y: 0, params: {} }])).toBe(false);
  });

  it("rejects a non-finite coordinate", () => {
    // Construct the object directly: a JSON round-trip would null NaN.
    expect(shapeOk([{ id: "n", type: "open_pr", x: NaN, y: 0, params: {} }])).toBe(false);
  });
});

describe("validateWorkflowGraph edge cases (graph rules)", () => {
  it("rule 6: flags send_plan_approval (terminal) with an outgoing edge", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("sp", "send_plan_approval"),
        node("p", "planning_agent"),
      ],
      [
        { from: "t", to: "sp" },
        { from: "sp", to: "p" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Terminal block "sp" (send_plan_approval) cannot have outgoing connections'),
      ),
    ).toBe(true);
  });

  it("rule 6: flags a loop edge that omits its port", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "fail" }),
        node("x", "open_pr"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "lp" },
        { from: "lp", to: "x" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Connection from loop "lp" must specify a port (continue/exhausted)'),
      ),
    ).toBe(true);
  });

  it("rule 6: flags the failure port used on a trigger as an unknown port", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("p", "planning_agent")],
      [{ from: "t", to: "p", fromPort: "failed" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes('uses unknown port "failed"')),
    ).toBe(true);
  });

  it("rule 9: flags a branch missing its 'true' port", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("b", "branch", { condition: "steps.p.output.ok" }),
        node("x", "open_pr"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "b" },
        { from: "b", to: "x", fromPort: "false" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "b" must have its "true" port connected'),
      ),
    ).toBe(true);
  });

  it("rule 12: flags a condition referencing an unknown block", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("b", "branch", { condition: "steps.ghost.output.ok" }),
        node("x", "open_pr"),
        node("y", "send_slack_message"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "b" },
        { from: "b", to: "x", fromPort: "true" },
        { from: "b", to: "y", fromPort: "false" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "b" condition references block "ghost" which does not run before it'),
      ),
    ).toBe(true);
  });

  it("rule 12: flags a condition that references the branch itself", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("b", "branch", { condition: "steps.b.output.ok" }),
        node("x", "open_pr"),
        node("y", "send_slack_message"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "b" },
        { from: "b", to: "x", fromPort: "true" },
        { from: "b", to: "y", fromPort: "false" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "b" condition references block "b" which does not run before it'),
      ),
    ).toBe(true);
  });

  it("returns exactly the one issue for a single-fault graph (pins message wording)", () => {
    // Two identical edges are the only fault: the exact-duplicate check fires first
    // and short-circuits, so no other rule contributes an issue.
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("p", "planning_agent")],
      [
        { from: "t", to: "p" },
        { from: "t", to: "p" },
      ],
    );
    expect(validateWorkflowGraph(def)).toEqual(['Duplicate connection from "t" to "p".']);
  });
});
