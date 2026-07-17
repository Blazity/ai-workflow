import { describe, expect, it } from "vitest";
import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import { defaultWorkflowDefinition } from "./default.js";
import {
  humanGateLoopDefinition,
  linearPipelineDefinition,
  planApprovalDefinition,
  prReviewFixDefinition,
} from "./graph-fixtures.js";
import {
  upgradeStoredWorkflowDefinition,
  validateWorkflowDefinitionForDeployment,
  validateWorkflowGraph,
  workflowDefinitionSchema,
} from "./schema.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
};

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

function clone(def: WorkflowDefinition): any {
  return JSON.parse(JSON.stringify(def));
}

function shapeOk(nodes: unknown[], edges: unknown[] = []): boolean {
  return workflowDefinitionSchema.safeParse({ schemaVersion: 1, nodes, edges }).success;
}

describe("workflowDefinitionSchema", () => {
  it("removes retired arthur_trace and splices only its normal output", () => {
    const upgraded = upgradeStoredWorkflowDefinition({
      schemaVersion: 1,
      nodes: [
        { id: "branch", type: "branch", x: 0, y: 0, params: { condition: "true" } },
        { id: "trace", type: "arthur_trace", x: 1, y: 0, params: {} },
        { id: "next", type: "open_pr", x: 2, y: 0, params: {} },
        { id: "impossible", type: "terminate", x: 2, y: 1, params: { terminalStatus: "failed" } },
      ],
      edges: [
        { from: "branch", to: "trace", fromPort: "false" },
        { from: "trace", to: "next", fromPort: "out" },
        { from: "trace", to: "impossible", fromPort: "failed" },
      ],
    });

    expect(upgraded.nodes.map((node) => node.type)).toEqual(["branch", "open_pr", "terminate"]);
    expect(upgraded.nodes.every((node) => Object.hasOwn(node, "inputs"))).toBe(true);
    expect(upgraded.edges).toEqual([{ from: "branch", to: "next", fromPort: "false" }]);
  });

  it("still rejects truly unknown stored block types", () => {
    expect(() =>
      upgradeStoredWorkflowDefinition({
        schemaVersion: 1,
        nodes: [{ id: "unknown", type: "retired_elsewhere", x: 0, y: 0, params: {} }],
        edges: [],
      }),
    ).toThrow(/Unknown workflow block type/);
  });

  it("preserves exact input binding source paths and defaults legacy nodes to no bindings", () => {
    const parsed = workflowDefinitionSchema.parse({
      schemaVersion: 1,
      nodes: [
        {
          id: "llm",
          type: "call_llm",
          x: 0,
          y: 0,
          params: { prompt: "summarize" },
          inputs: {
            prompt: "steps.plan.output.plan",
            context: "trigger.ticket.description",
            runId: "run.id",
          },
        },
        { id: "legacy", type: "open_pr", x: 0, y: 0, params: {} },
      ],
      edges: [],
    });

    expect(parsed.nodes[0].inputs).toEqual({
      prompt: "steps.plan.output.plan",
      context: "trigger.ticket.description",
      runId: "run.id",
    });
    expect(parsed.nodes[1].inputs).toEqual({});
  });

  it("upgrades bespoke step params and preserves requiredChecks as typed inputs", () => {
    const upgraded = upgradeStoredWorkflowDefinition({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "plan", type: "planning_agent", x: 0, y: 0, params: {} },
        { id: "checks", type: "run_checks", x: 0, y: 0, params: {} },
        {
          id: "approval",
          type: "send_plan_approval",
          x: 1,
          y: 0,
          params: { planFromStep: "plan", mirrorComment: false },
        },
        {
          id: "explicit",
          type: "send_plan_approval",
          x: 1,
          y: 1,
          params: { planFromStep: "plan" },
          inputs: { plan: "run.branchName" },
        },
        {
          id: "finalize",
          type: "finalize_workspace",
          x: 2,
          y: 0,
          params: { requiredChecks: ["checks"] },
        },
      ],
      edges: [
        { from: "trigger", to: "checks" },
        { from: "checks", to: "finalize" },
      ],
    });

    expect(upgraded.nodes.find((entry) => entry.id === "approval")).toMatchObject({
      params: { mirrorComment: false },
      inputs: {
        plan: "steps.plan.output.plan",
      },
    });
    expect(upgraded.nodes.find((entry) => entry.id === "explicit")).toMatchObject({
      params: {},
      inputs: {
        plan: "run.branchName",
      },
    });
    expect(upgraded.nodes.find((entry) => entry.id === "finalize")).toMatchObject({
      params: {},
      inputs: { "checks.checks": "steps.checks.output.status" },
    });
  });

  it("preserves unrepresentable, missing, and non-dominating legacy Finalize gates", () => {
    const raw = {
      schemaVersion: 1 as const,
      nodes: [
        { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "safe", type: "run_checks", x: 0, y: 0, params: {} },
        { id: "side", type: "run_checks", x: 0, y: 1, params: {} },
        { id: "checks.with.dot", type: "run_checks", x: 0, y: 2, params: {} },
        { id: "checks space", type: "run_checks", x: 0, y: 3, params: {} },
        {
          id: "finalize",
          type: "finalize_workspace",
          x: 1,
          y: 0,
          params: {
            requiredChecks: [
              "safe",
              "checks.with.dot",
              "checks space",
              "missing",
              "side",
              "safe",
            ],
          },
        },
      ],
      edges: [
        { from: "trigger", to: "safe" },
        { from: "safe", to: "finalize" },
        { from: "trigger", to: "side" },
      ],
    };

    const upgraded = upgradeStoredWorkflowDefinition(raw);
    expect(upgraded.nodes.find((entry) => entry.id === "finalize")).toMatchObject({
      inputs: { "checks.safe": "steps.safe.output.status" },
      params: {
        legacyRequiredChecks: ["checks.with.dot", "checks space", "missing", "side"],
      },
    });
    expect(upgradeStoredWorkflowDefinition(upgraded)).toEqual(upgraded);
  });

  it("upgrades default Arthur content producers and preserves dynamic or unknown producers for repair", () => {
    const upgraded = upgradeStoredWorkflowDefinition({
      schemaVersion: 1,
      nodes: [
        { id: "plan", type: "planning_agent", x: 0, y: 0, params: {} },
        { id: "generic", type: "generic_agent", x: 0, y: 1, params: { prompt: "p" } },
        { id: "llm", type: "call_llm", x: 0, y: 2, params: { prompt: "p" } },
        {
          id: "generic-dynamic",
          type: "generic_agent",
          x: 0,
          y: 3,
          params: { prompt: "p", outputSchema: '{"type":"string"}' },
        },
        {
          id: "llm-dynamic",
          type: "call_llm",
          x: 0,
          y: 4,
          params: { prompt: "p", outputSchema: '{"type":"string"}' },
        },
        { id: "fix", type: "fix_agent", x: 0, y: 5, params: {} },
        {
          id: "check-plan",
          type: "arthur_injection_check",
          x: 1,
          y: 0,
          params: { contentFromStep: "plan" },
        },
        {
          id: "check-generic",
          type: "arthur_injection_check",
          x: 1,
          y: 1,
          params: { contentFromStep: "generic" },
        },
        {
          id: "check-llm",
          type: "arthur_injection_check",
          x: 1,
          y: 2,
          params: { contentFromStep: "llm" },
        },
        {
          id: "check-generic-dynamic",
          type: "arthur_injection_check",
          x: 1,
          y: 3,
          params: { contentFromStep: "generic-dynamic" },
        },
        {
          id: "check-llm-dynamic",
          type: "arthur_injection_check",
          x: 1,
          y: 4,
          params: { contentFromStep: "llm-dynamic" },
        },
        {
          id: "check-unknown",
          type: "arthur_injection_check",
          x: 1,
          y: 5,
          params: { contentFromStep: "fix" },
        },
      ],
      edges: [],
    });

    expect(upgraded.nodes.find((entry) => entry.id === "check-plan")?.inputs.content).toBe(
      "steps.plan.output.plan",
    );
    expect(upgraded.nodes.find((entry) => entry.id === "check-generic")?.inputs.content).toBe(
      "steps.generic.output.body",
    );
    expect(upgraded.nodes.find((entry) => entry.id === "check-llm")?.inputs.content).toBe(
      "steps.llm.output.output",
    );
    expect(upgraded.nodes.find((entry) => entry.id === "check-generic-dynamic")).toMatchObject({
      params: { legacyContentFromStep: "generic-dynamic" },
      inputs: {},
    });
    expect(upgraded.nodes.find((entry) => entry.id === "check-llm-dynamic")).toMatchObject({
      params: { legacyContentFromStep: "llm-dynamic" },
      inputs: {},
    });
    expect(upgraded.nodes.find((entry) => entry.id === "check-unknown")).toMatchObject({
      params: { legacyContentFromStep: "fix" },
      inputs: {},
    });
  });

  it("rejects blank or non-string input binding sources", () => {
    const base = { id: "n", type: "call_llm", x: 0, y: 0, params: { prompt: "p" } };
    expect(shapeOk([{ ...base, inputs: { prompt: "" } }])).toBe(false);
    expect(shapeOk([{ ...base, inputs: { prompt: 42 } }])).toBe(false);
  });

  it("rejects binding sources outside the three persisted source roots", () => {
    const base = { id: "n", type: "call_llm", x: 0, y: 0, params: { prompt: "p" } };
    for (const source of [
      "banana",
      "trigger.",
      "run.",
      "steps..output.plan",
      "steps.self.output",
      "steps.self.output.",
      "steps.self.plan",
    ]) {
      expect(shapeOk([{ ...base, inputs: { prompt: source } }]), source).toBe(false);
    }
  });

  it("rejects whitespace-normalized and prototype-bearing binding sources", () => {
    const base = { id: "n", type: "call_llm", x: 0, y: 0, params: { prompt: "p" } };
    for (const source of [
      " trigger.ticketKey",
      "trigger.ticketKey ",
      "run.constructor.name",
      "steps.plan.output.__proto__.value",
    ]) {
      expect(shapeOk([{ ...base, inputs: { prompt: source } }]), source).toBe(false);
    }
  });

  it("rejects unsafe dynamic input names before validation", () => {
    const base = {
      id: "n",
      type: "finalize_workspace",
      x: 0,
      y: 0,
      params: {},
    };
    for (const name of ["constructor", "checks.constructor", "checks.__proto__", "checks..lint"]) {
      expect(
        shapeOk([{ ...base, inputs: { [name]: "steps.lint.output.status" } }]),
        name,
      ).toBe(false);
    }
  });

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

  it("rejects a blank update_ticket_status target", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "update_ticket_status").params.target = "";
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

describe("workflowDefinitionSchema block-executor node types", () => {
  function parseNode(raw: Record<string, unknown>) {
    const parsed = workflowDefinitionSchema.safeParse({
      schemaVersion: 1,
      nodes: [{ id: "n", x: 0, y: 0, ...raw }],
      edges: [],
    });
    return parsed.success ? parsed.data.nodes[0] : null;
  }

  it("accepts valid params for every new block type", () => {
    const valid: Array<[WorkflowBlockType, Record<string, WorkflowParamValue>]> = [
      ["trigger_plan_approved", {}],
      ["trigger_pr_created", {}],
      ["trigger_pr_checks_failed", {}],
      ["trigger_pr_review", {}],
      ["prepare_workspace", {}],
      ["finalize_workspace", {}],
      ["fix_agent", { provider: "codex", model: "gpt-5", instructions: "focus", maxMinutes: 30 }],
      ["generic_agent", { provider: "claude", prompt: "do it", outputSchema: "{}" }],
      ["call_llm", { prompt: "summarize", system: "be terse", model: "claude-haiku-4-5" }],
      ["fetch_pr_context", {}],
      ["run_checks", { commands: ["pnpm test"] }],
      ["post_ticket_comment", { body: "done" }],
      ["post_pr_comment", { body: "done", target: "all" }],
      ["human_question", { questions: ["Which env?"] }],
      ["arthur_injection_check", {}],
    ];
    for (const [type, params] of valid) {
      expect(shapeOk([node("n", type, params)]), type).toBe(true);
    }
  });

  it("rejects unknown param keys on every new block type", () => {
    const types: WorkflowBlockType[] = [
      "trigger_plan_approved",
      "trigger_pr_created",
      "trigger_pr_checks_failed",
      "trigger_pr_review",
      "prepare_workspace",
      "finalize_workspace",
      "fix_agent",
      "call_llm",
      "fetch_pr_context",
      "run_checks",
      "human_question",
      "arthur_injection_check",
    ];
    for (const type of types) {
      expect(shapeOk([node("n", type, { bogus: 1 })]), type).toBe(false);
    }
    expect(shapeOk([node("n", "generic_agent", { prompt: "p", bogus: 1 })])).toBe(false);
    expect(shapeOk([node("n", "post_ticket_comment", { body: "b", bogus: 1 })])).toBe(false);
    expect(shapeOk([node("n", "post_pr_comment", { body: "b", bogus: 1 })])).toBe(false);
  });

  it("applies PR-trigger param defaults and rejects unknown keys", () => {
    expect(parseNode({ type: "trigger_plan_approved", params: {} })?.params).toEqual({});
    expect(parseNode({ type: "trigger_pr_created", params: {} })?.params).toEqual({
      providers: ["github", "gitlab"],
      onlyWorkflowOwned: true,
    });
    expect(parseNode({ type: "trigger_pr_checks_failed", params: {} })?.params).toEqual({
      providers: ["github", "gitlab"],
    });
    expect(parseNode({ type: "trigger_pr_review", params: {} })?.params).toEqual({
      providers: ["github"],
      on: ["changes_requested"],
    });
    // Restored params round-trip.
    expect(
      parseNode({ type: "trigger_pr_created", params: { onlyWorkflowOwned: false } })?.params,
    ).toEqual({ providers: ["github", "gitlab"], onlyWorkflowOwned: false });
    expect(
      parseNode({ type: "trigger_pr_review", params: { on: ["changes_requested", "commented"] } })
        ?.params,
    ).toEqual({ providers: ["github"], on: ["changes_requested", "commented"] });
    // Unknown keys and out-of-enum values are still rejected (strict).
    expect(parseNode({ type: "trigger_pr_created", params: { bogus: 1 } })).toBeNull();
    expect(parseNode({ type: "trigger_pr_review", params: { on: ["approved"] } })).toBeNull();
  });

  it("applies action param defaults", () => {
    expect(parseNode({ type: "fix_agent", params: {} })?.params).toEqual({ maxMinutes: 25 });
    // call_llm intentionally has NO model default: leaving it unset lets the
    // executor resolve the model from provider/run default at runtime.
    expect(parseNode({ type: "call_llm", params: { prompt: "p" } })?.params).toEqual({
      prompt: "p",
    });
    expect(parseNode({ type: "post_pr_comment", params: { body: "b" } })?.params).toEqual({
      body: "b",
      target: "primary",
    });
  });

  it("allowlists the model param and rejects shell-metacharacter model ids", () => {
    // Safe ids (alphanumerics + . _ : / -) pass on every agent-ish block.
    expect(shapeOk([node("n", "planning_agent", { model: "claude-opus-4-6" })])).toBe(true);
    expect(shapeOk([node("n", "implementation_agent", { model: "us.anthropic.claude:v1/2" })])).toBe(true);
    expect(shapeOk([node("n", "review_agent", { model: "gpt-5-codex" })])).toBe(true);
    // Injection payloads are rejected at save time (400).
    expect(shapeOk([node("n", "planning_agent", { model: "m'; rm -rf /" })])).toBe(false);
    expect(shapeOk([node("n", "implementation_agent", { model: "$(whoami)" })])).toBe(false);
    expect(shapeOk([node("n", "generic_agent", { prompt: "p", model: "has space" })])).toBe(false);
    expect(shapeOk([node("n", "fix_agent", { model: 'gpt"5' })])).toBe(false);
    expect(shapeOk([node("n", "call_llm", { prompt: "p", model: "back`tick" })])).toBe(false);
  });

  it("bounds fix_agent maxMinutes and requires generic_agent prompt", () => {
    expect(shapeOk([node("n", "fix_agent", { maxMinutes: 4 })])).toBe(false);
    expect(shapeOk([node("n", "fix_agent", { maxMinutes: 61 })])).toBe(false);
    expect(shapeOk([node("n", "generic_agent", {})])).toBe(false);
    expect(shapeOk([node("n", "generic_agent", { prompt: "" })])).toBe(false);
  });

  it("restricts update_ticket_status target to the two domain values", () => {
    expect(shapeOk([node("n", "update_ticket_status", { target: "ai_review" })])).toBe(true);
    expect(shapeOk([node("n", "update_ticket_status", { target: "backlog" })])).toBe(true);
    // A column label or a near-miss typo used to save clean and then silently
    // resolve to ai_review at run time (resolveTicketMoveTarget's fallback).
    expect(shapeOk([node("n", "update_ticket_status", { target: "Code Review" })])).toBe(false);
    expect(shapeOk([node("n", "update_ticket_status", { target: "Backlog" })])).toBe(false);
    expect(shapeOk([node("n", "update_ticket_status", { target: "" })])).toBe(false);
  });

  it("caps the graph size", () => {
    const trigger = node("t", "trigger_ticket_ai");
    const filler = (count: number) =>
      Array.from({ length: count }, (_, i) => node(`n${i}`, "open_pr"));
    expect(shapeOk([trigger, ...filler(199)])).toBe(true);
    expect(shapeOk([trigger, ...filler(200)])).toBe(false);

    const edges = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ from: "t", to: `n${i}` }));
    expect(shapeOk([trigger, ...filler(199)], edges(400))).toBe(true);
    expect(shapeOk([trigger, ...filler(199)], edges(401))).toBe(false);
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

  it("accepts the plan-approval fixture", () => {
    const def = planApprovalDefinition();
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("accepts the PR-review-fix fixture", () => {
    const def = prReviewFixDefinition();
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
        issue.includes('Terminal block "term" (terminate) cannot have outgoing connections'),
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

  it("rule 12: flags a condition referencing a block on only one branch (not a dominator)", () => {
    // "left" runs on the true arm only, so a run reaching "merge" via the false
    // arm never produces its output. It is an ancestor on one path but does not
    // dominate the merge, so it must be rejected.
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("split", "branch", { condition: "true" }),
        node("left", "planning_agent"),
        node("right", "implementation_agent"),
        node("merge", "branch", { condition: "steps.left.output.ok" }),
        node("x", "open_pr"),
        node("y", "send_slack_message"),
      ],
      [
        { from: "t", to: "split" },
        { from: "split", to: "left", fromPort: "true" },
        { from: "split", to: "right", fromPort: "false" },
        { from: "left", to: "merge" },
        { from: "right", to: "merge" },
        { from: "merge", to: "x", fromPort: "true" },
        { from: "merge", to: "y", fromPort: "false" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "merge" condition references block "left" which does not run before it'),
      ),
    ).toBe(true);
  });

  it("rule 12: flags a condition referencing a later loop-body block that does not dominate it", () => {
    // The branch runs before "fix" the first time through, so on that path
    // "fix" has no output; being a cycle member does not make it a dominator.
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
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "b" condition references block "fix" which does not run before it'),
      ),
    ).toBe(true);
  });

  it("rule 12: allows a condition referencing a dominator reached across a loop back-edge", () => {
    // "checks" is the branch's sole predecessor, so it dominates the branch on
    // every path, including loop iterations (verdict --false--> loop --> fix -->
    // checks). The loop back-edge must not break the dominator computation.
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("checks", "run_pre_pr_checks"),
        node("verdict", "branch", { condition: "steps.checks.output.ok" }),
        node("open", "open_pr"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "fail" }),
        node("fix", "review_agent"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "checks" },
        { from: "checks", to: "verdict" },
        { from: "verdict", to: "open", fromPort: "true" },
        { from: "verdict", to: "lp", fromPort: "false" },
        { from: "lp", to: "fix", fromPort: "continue" },
        { from: "fix", to: "checks" },
      ],
    );
    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("keeps structural draft validation separate from deploy-grade binding validation", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        {
          ...node("approve", "send_plan_approval"),
          inputs: { plan: "steps.ghost.output.plan" },
        },
      ],
      [{ from: "t", to: "approve" }],
    );

    expect(validateWorkflowGraph(def)).toEqual([]);
    expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual(
      expect.arrayContaining([expect.stringContaining('references unknown block "ghost"')]),
    );
  });

  it("rejects environmentally unavailable blocks only at deployment validation", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("slack", "send_slack_message")],
      [{ from: "t", to: "slack" }],
    );
    const unavailable = { ...registryContext, slackConfigured: false };

    expect(validateWorkflowGraph(def)).toEqual([]);
    expect(validateWorkflowDefinitionForDeployment(def, unavailable)).toEqual(
      expect.arrayContaining([
        'Block "slack" (send_slack_message) is unavailable: Slack messaging is not configured.',
      ]),
    );
  });

  it("rejects malformed declared output schemas even when environment checks are skipped", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("generate", "generic_agent", {
          prompt: "generate",
          outputSchema: '{"type":"made-up"}',
        }),
      ],
      [{ from: "t", to: "generate" }],
    );

    expect(
      validateWorkflowDefinitionForDeployment(def, registryContext, {
        checkEnvironmentAvailability: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        'Block "generate" (generic_agent) is unavailable: outputSchema has unsupported type "made-up".',
      ]),
    );
  });

  it("explains how to repair a legacy Arthur whole-output reference before deployment", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("fix", "fix_agent"),
        node("check", "arthur_injection_check", { legacyContentFromStep: "fix" }),
      ],
      [
        { from: "t", to: "fix" },
        { from: "fix", to: "check" },
      ],
    );

    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Block "check" must replace legacy contentFromStep "fix"'),
      ]),
    );
  });

  it("loads but will not redeploy an execution-only legacy Finalize gate", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("finalize", "finalize_workspace", {
          legacyRequiredChecks: ["checks.with.dot", "missing"],
        }),
      ],
      [{ from: "t", to: "finalize" }],
    );

    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Block "finalize" must replace legacy requiredChecks "checks.with.dot, missing"',
        ),
      ]),
    );
    expect(
      validateWorkflowDefinitionForDeployment(def, registryContext, {
        allowLegacyCompatibility: true,
      }),
    ).toEqual([]);
  });
});
