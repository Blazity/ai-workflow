import { describe, expect, it } from "vitest";
import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import { defaultWorkflowDefinition } from "./default.js";
import { humanGateLoopDefinition, linearPipelineDefinition } from "./graph-fixtures.js";
import { validateWorkflowGraph, workflowDefinitionSchema } from "./schema.js";

function node(
  id: string,
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue> = {},
): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params };
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

function shapeOk(nodes: unknown[], edges: unknown[] = []): boolean {
  return workflowDefinitionSchema.safeParse({ schemaVersion: 1, nodes, edges }).success;
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

  it("accepts a provider on every agent block type", () => {
    for (const provider of ["claude", "codex"] as const) {
      const def = clone(defaultWorkflowDefinition({ includeReview: true }));
      for (const type of ["planning_agent", "implementation_agent", "review_agent"]) {
        def.nodes.find((n: WorkflowDefinitionNode) => n.type === type).params.provider = provider;
      }
      expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    }
  });

  it("rejects an invalid provider value", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: true }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "planning_agent").params.provider = "gemini";
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects a provider on a non-agent block type", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: true }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "open_pr").params.provider = "claude";
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("accepts a legacy definition without a provider", () => {
    const def = defaultWorkflowDefinition({ includeReview: true });
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it("accepts a well-formed branch node and rejects out-of-bound conditions", () => {
    const good = { id: "b", type: "branch", x: 0, y: 0, params: { condition: "steps.a.output.ok" } };
    expect(shapeOk([good])).toBe(true);
    expect(shapeOk([{ ...good, params: { condition: "" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { condition: "x".repeat(1001) } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { condition: "steps.a.output.ok", extra: 1 } }])).toBe(false);
  });

  it("accepts a well-formed loop node and rejects invalid params", () => {
    const good = { id: "l", type: "loop", x: 0, y: 0, params: { maxAttempts: 3, onExhaust: "fail" } };
    expect(shapeOk([good])).toBe(true);
    expect(shapeOk([{ ...good, params: { maxAttempts: 0, onExhaust: "fail" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { maxAttempts: 21, onExhaust: "fail" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { maxAttempts: 2.5, onExhaust: "fail" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { maxAttempts: 3, onExhaust: "bogus" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { maxAttempts: 3 } }])).toBe(false);
  });

  it("accepts a well-formed terminate node and rejects invalid params", () => {
    const good = { id: "x", type: "terminate", x: 0, y: 0, params: { terminalStatus: "done" } };
    expect(shapeOk([good])).toBe(true);
    expect(
      shapeOk([{ ...good, params: { terminalStatus: "waiting_for_human", postComment: "please review" } }]),
    ).toBe(true);
    expect(shapeOk([{ ...good, params: { terminalStatus: "unknown" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { terminalStatus: "done", postComment: "" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { terminalStatus: "done", extra: 1 } }])).toBe(false);
  });

  it("accepts an edge fromPort and rejects an empty one", () => {
    const nodes = [node("t", "trigger_ticket_ai"), node("p", "planning_agent")];
    expect(shapeOk(nodes, [{ from: "t", to: "p", fromPort: "out" }])).toBe(true);
    expect(shapeOk(nodes, [{ from: "t", to: "p", fromPort: "" }])).toBe(false);
  });
});

describe("validateWorkflowGraph fixtures", () => {
  it("accepts the linear pipeline fixture", () => {
    const def = linearPipelineDefinition();
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("accepts the human-gate loop fixture", () => {
    const def = humanGateLoopDefinition();
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateWorkflowGraph(def)).toEqual([]);
  });
});

describe("validateWorkflowGraph rules", () => {
  it("rule 1: flags a duplicate node id", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("dup", "planning_agent"), node("dup", "open_pr")],
      [{ from: "t", to: "dup" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes('Block id "dup" is used more than once')),
    ).toBe(true);
  });

  it("rule 2: flags a workflow without any trigger", () => {
    const def = graph([node("p", "planning_agent")], []);
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes("Workflow must contain at least one trigger block."),
      ),
    ).toBe(true);
  });

  it("rule 3: flags two triggers of the same type", () => {
    const def = graph(
      [node("t1", "trigger_ticket_ai"), node("t2", "trigger_ticket_ai")],
      [],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes("Workflow contains more than one trigger_ticket_ai trigger block."),
      ),
    ).toBe(true);
  });

  it("rule 4: flags a trigger with an incoming edge", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("p", "planning_agent")],
      [{ from: "p", to: "t" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes("must not have incoming connections")),
    ).toBe(true);
  });

  it("rule 5: flags edges referencing unknown blocks and self-edges", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("p", "planning_agent")],
      [
        { from: "ghost-source", to: "p" },
        { from: "p", to: "ghost-target" },
        { from: "p", to: "p" },
      ],
    );
    const issues = validateWorkflowGraph(def);
    expect(issues.some((issue) => issue.includes('unknown source block "ghost-source"'))).toBe(true);
    expect(issues.some((issue) => issue.includes('unknown target block "ghost-target"'))).toBe(true);
    expect(issues.some((issue) => issue.includes('Block "p" cannot connect to itself'))).toBe(true);
  });

  it("rule 6: flags an unknown port", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("p", "planning_agent")],
      [{ from: "t", to: "p", fromPort: "bogus" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('uses unknown port "bogus" of block type trigger_ticket_ai'),
      ),
    ).toBe(true);
  });

  it("rule 6: flags a branch edge that omits its port", () => {
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
        { from: "b", to: "x" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Connection from branch "b" must specify a port (true/false)'),
      ),
    ).toBe(true);
  });

  it("rule 6: flags a terminate block with an outgoing edge", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("term", "terminate", { terminalStatus: "done" }),
        node("p", "planning_agent"),
      ],
      [
        { from: "t", to: "term" },
        { from: "term", to: "p" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Terminate block "term" cannot have outgoing connections'),
      ),
    ).toBe(true);
  });

  it("rule 7: forbids a fan-out from a single port", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("a", "open_pr"),
        node("b", "send_slack_message"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "a" },
        { from: "p", to: "b" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Block "p" has multiple connections from port "out"'),
      ),
    ).toBe(true);
  });

  it("rule 7: flags an exact duplicate connection", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("p", "planning_agent")],
      [
        { from: "t", to: "p" },
        { from: "t", to: "p" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Duplicate connection from "t" to "p"'),
      ),
    ).toBe(true);
  });

  it("rule 7: allows a failure-port fan-out alongside the default port", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("ok", "open_pr"),
        node("bad", "send_slack_message"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "ok" },
        { from: "p", to: "bad", fromPort: "failed" },
      ],
    );
    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("rule 8: flags an unreachable node", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("orphan", "send_slack_message"),
      ],
      [{ from: "t", to: "p" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Block "orphan" is not reachable from a trigger'),
      ),
    ).toBe(true);
  });

  it("rule 9: flags a half-wired branch", () => {
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
        { from: "b", to: "x", fromPort: "true" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "b" must have its "false" port connected'),
      ),
    ).toBe(true);
  });

  it("rule 10: flags a loop whose continue port does not lead back", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "fail" }),
        node("f", "open_pr"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "lp" },
        { from: "lp", to: "f", fromPort: "continue" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes(`Loop "lp"'s continue port must lead back to it`),
      ),
    ).toBe(true);
  });

  it("rule 10: flags onExhaust continue without an exhausted edge", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "continue" }),
        node("f", "implementation_agent"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "lp" },
        { from: "lp", to: "f", fromPort: "continue" },
        { from: "f", to: "lp" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes(
          'Loop "lp" with onExhaust "continue" must have its "exhausted" port connected',
        ),
      ),
    ).toBe(true);
  });

  it("rule 10: flags a loop missing its continue edge", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "fail" }),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "lp" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Loop "lp" must have its "continue" port connected'),
      ),
    ).toBe(true);
  });

  it("rule 11: flags a cycle that passes through no loop", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("a", "planning_agent"),
        node("b", "implementation_agent"),
      ],
      [
        { from: "t", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes("form a cycle that does not pass through a Loop block"),
      ),
    ).toBe(true);
  });

  it("rule 11: flags a cycle region containing two loops", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("lp1", "loop", { maxAttempts: 3, onExhaust: "fail" }),
        node("lp2", "loop", { maxAttempts: 3, onExhaust: "fail" }),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "lp1" },
        { from: "lp1", to: "lp2", fromPort: "continue" },
        { from: "lp2", to: "lp1", fromPort: "continue" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes("form a cycle region with 2 Loop blocks; each cycle region must contain exactly one"),
      ),
    ).toBe(true);
  });

  it("rule 12: flags an invalid branch condition", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("b", "branch", { condition: "this is not valid @@@" }),
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
        issue.includes('Branch "b" has an invalid condition:'),
      ),
    ).toBe(true);
  });

  it("rule 12: flags a condition referencing a non-ancestor block", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("b", "branch", { condition: "steps.other.output.ok" }),
        node("x", "open_pr"),
        node("other", "send_slack_message"),
        node("y", "implementation_agent"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "b" },
        { from: "b", to: "x", fromPort: "true" },
        { from: "x", to: "other" },
        { from: "b", to: "y", fromPort: "false" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "b" condition references block "other" which does not run before it'),
      ),
    ).toBe(true);
  });

  it("rule 12: allows a condition referencing a cycle-member ancestor", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("checks", "run_pre_pr_checks"),
        node("b", "branch", { condition: "steps.fix.output.ok" }),
        node("open", "open_pr"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "fail" }),
        node("fix", "review_agent"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "checks" },
        { from: "checks", to: "b" },
        { from: "b", to: "open", fromPort: "true" },
        { from: "b", to: "lp", fromPort: "false" },
        { from: "lp", to: "fix", fromPort: "continue" },
        { from: "fix", to: "checks" },
      ],
    );
    expect(validateWorkflowGraph(def)).toEqual([]);
  });
});
