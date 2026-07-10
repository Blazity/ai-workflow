import { describe, expect, it } from "vitest";
import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import { defaultWorkflowDefinition } from "./default.js";
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

function clone(def: WorkflowDefinition): any {
  return JSON.parse(JSON.stringify(def));
}

describe("workflowDefinitionSchema", () => {
  it("accepts the default definition (with and without review) and graph validates", () => {
    for (const includeReview of [true, false]) {
      const def = defaultWorkflowDefinition({ includeReview });
      expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
      expect(validateWorkflowGraph(def)).toEqual([]);
    }
  });

  it("rejects an unknown param key", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "planning_agent").params.foo = 1;
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects an unknown block type", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.nodes[1].type = "does_not_exist";
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects a bad update_ticket_status target", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "update_ticket_status").params.target = "done";
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects maxFixCycles out of bounds", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "run_pre_pr_checks").params.maxFixCycles = 6;
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects schemaVersion 2", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.schemaVersion = 2;
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });
});

describe("validateWorkflowGraph", () => {
  it("flags two triggers", () => {
    const def = graph(
      [node("t1", "trigger_ticket_ai"), node("t2", "trigger_ticket_ai")],
      [],
    );
    expect(validateWorkflowGraph(def).some((issue) => issue.includes("exactly one trigger"))).toBe(true);
  });

  it("flags a trigger with an incoming edge", () => {
    const def = graph(
      [node("trigger", "trigger_ticket_ai"), node("planning", "planning_agent")],
      [{ from: "planning", to: "trigger" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes("must not have incoming connections")),
    ).toBe(true);
  });

  it("flags a cycle", () => {
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
    expect(validateWorkflowGraph(def).length).toBeGreaterThan(0);
  });

  it("flags an unreachable node", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("implementation", "implementation_agent"),
        node("open-pr", "open_pr"),
        node("status", "update_ticket_status"),
        node("orphan", "send_slack_message"),
      ],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "implementation" },
        { from: "implementation", to: "open-pr" },
        { from: "open-pr", to: "status" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes("is not reachable from the trigger")),
    ).toBe(true);
  });

  it("flags a fan-out (out-degree 2)", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("implementation", "implementation_agent"),
        node("open-pr", "open_pr"),
      ],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "implementation" },
        { from: "planning", to: "open-pr" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes("more than one outgoing connection")),
    ).toBe(true);
  });

  it("flags a duplicate agent phase", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("planning2", "planning_agent"),
      ],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "planning2" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes("at most one planning_agent")),
    ).toBe(true);
  });

  it("flags a missing required block", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("implementation", "implementation_agent"),
        node("status", "update_ticket_status"),
      ],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "implementation" },
        { from: "implementation", to: "status" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes("missing a required open_pr")),
    ).toBe(true);
  });

  it("flags planning after implementation", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("implementation", "implementation_agent"),
        node("planning", "planning_agent"),
        node("open-pr", "open_pr"),
        node("status", "update_ticket_status"),
      ],
      [
        { from: "trigger", to: "implementation" },
        { from: "implementation", to: "planning" },
        { from: "planning", to: "open-pr" },
        { from: "open-pr", to: "status" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes("planning_agent block must come before the implementation_agent"),
      ),
    ).toBe(true);
  });

  it("flags open_pr before implementation", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("open-pr", "open_pr"),
        node("implementation", "implementation_agent"),
        node("status", "update_ticket_status"),
      ],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "open-pr" },
        { from: "open-pr", to: "implementation" },
        { from: "implementation", to: "status" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes("open_pr block must come after the implementation_agent"),
      ),
    ).toBe(true);
  });

  it("flags a missing trigger", () => {
    const def = graph(
      [node("planning", "planning_agent"), node("implementation", "implementation_agent")],
      [{ from: "planning", to: "implementation" }],
    );
    expect(validateWorkflowGraph(def).some((issue) => issue.includes("exactly one trigger"))).toBe(true);
  });

  it("flags edges referencing unknown blocks", () => {
    const def = graph(
      [node("trigger", "trigger_ticket_ai"), node("planning", "planning_agent")],
      [
        { from: "ghost-source", to: "planning" },
        { from: "planning", to: "ghost-target" },
      ],
    );
    const issues = validateWorkflowGraph(def);
    expect(issues.some((issue) => issue.includes('unknown source block "ghost-source"'))).toBe(true);
    expect(issues.some((issue) => issue.includes('unknown target block "ghost-target"'))).toBe(true);
  });

  it("flags a self-edge", () => {
    const def = graph(
      [node("trigger", "trigger_ticket_ai"), node("planning", "planning_agent")],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "planning" },
      ],
    );
    expect(validateWorkflowGraph(def).some((issue) => issue.includes("cannot connect to itself"))).toBe(true);
  });

  it("flags a duplicate edge", () => {
    const def = graph(
      [node("trigger", "trigger_ticket_ai"), node("planning", "planning_agent")],
      [
        { from: "trigger", to: "planning" },
        { from: "trigger", to: "planning" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Duplicate connection from "trigger" to "planning"'),
      ),
    ).toBe(true);
  });

  it("flags a fan-in (in-degree 2)", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("implementation", "implementation_agent"),
        node("slack", "send_slack_message"),
      ],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "implementation" },
        { from: "slack", to: "implementation" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes("more than one incoming connection")),
    ).toBe(true);
  });

  it("flags slack and status placed before open_pr", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("implementation", "implementation_agent"),
        node("slack", "send_slack_message"),
        node("status", "update_ticket_status"),
        node("open-pr", "open_pr"),
      ],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "implementation" },
        { from: "implementation", to: "slack" },
        { from: "slack", to: "status" },
        { from: "status", to: "open-pr" },
      ],
    );
    const issues = validateWorkflowGraph(def);
    expect(issues.some((issue) => issue.includes("send_slack_message block must come after the open_pr"))).toBe(true);
    expect(issues.some((issue) => issue.includes("update_ticket_status block must come after the open_pr"))).toBe(true);
  });

  it("flags review and checks placed before implementation", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("review", "review_agent"),
        node("checks", "run_pre_pr_checks"),
        node("implementation", "implementation_agent"),
        node("open-pr", "open_pr"),
        node("status", "update_ticket_status"),
      ],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "review" },
        { from: "review", to: "checks" },
        { from: "checks", to: "implementation" },
        { from: "implementation", to: "open-pr" },
        { from: "open-pr", to: "status" },
      ],
    );
    const issues = validateWorkflowGraph(def);
    expect(issues.some((issue) => issue.includes("review_agent block must come after the implementation_agent"))).toBe(true);
    expect(issues.some((issue) => issue.includes("run_pre_pr_checks block must come after the implementation_agent"))).toBe(true);
  });

  it("flags a duplicate node id", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("dup", "planning_agent"),
        node("dup", "open_pr"),
      ],
      [{ from: "trigger", to: "dup" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes('Block id "dup" is used more than once')),
    ).toBe(true);
  });

  it("flags a duplicate non-agent block type", () => {
    const def = graph(
      [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("implementation", "implementation_agent"),
        node("open-pr", "open_pr"),
        node("open-pr-2", "open_pr"),
        node("status", "update_ticket_status"),
      ],
      [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "implementation" },
        { from: "implementation", to: "open-pr" },
        { from: "open-pr", to: "open-pr-2" },
        { from: "open-pr-2", to: "status" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes("at most one open_pr block")),
    ).toBe(true);
  });
});
