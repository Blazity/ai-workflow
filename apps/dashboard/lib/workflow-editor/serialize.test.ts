import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCK_PARAM_KEYS } from "@shared/contracts";
import {
  serializeSemanticWorkflowDefinition,
  serializeWorkflowDefinition,
  serializeWorkflowLayout,
} from "./serialize.ts";
import type { FlowEdgeDef, FlowNodeDef } from "../flows.ts";

type TestFlowNode = Omit<FlowNodeDef, "inputs"> & Partial<Pick<FlowNodeDef, "inputs">>;

function flowNodes(nodes: TestFlowNode[]): FlowNodeDef[] {
  return nodes.map((node) => ({ ...node, inputs: node.inputs ?? {} }));
}

function assertSerializedNodes(actual: ReturnType<typeof serializeWorkflowDefinition>["nodes"], expected: unknown[]): void {
  assert.deepEqual(
    actual.map(({ inputs: _inputs, ...node }) => node),
    expected,
  );
  assert.deepEqual(
    actual.map((node) => node.inputs),
    actual.map(() => ({})),
  );
}

test("call_llm allows its provider key (no dashboard/shared drift)", () => {
  // Guards the drift that dropped call_llm.provider on save: the serializer now
  // derives its key allowlist from the shared BLOCK_PARAM_KEYS.
  assert.equal(BLOCK_PARAM_KEYS.call_llm.includes("provider"), true);
});

test("moving a block changes layout but not the semantic definition", () => {
  const before = flowNodes([
    { id: "trigger", type: "trigger_ticket_ai", x: 10, y: 20, params: {} },
  ]);
  const after = before.map((node) => ({ ...node, x: 90, y: 120 }));

  assert.deepEqual(
    serializeSemanticWorkflowDefinition(after, []),
    serializeSemanticWorkflowDefinition(before, []),
  );
  assert.notDeepEqual(serializeWorkflowLayout(after), serializeWorkflowLayout(before));
});

test("round-trips call_llm provider through serialization without loss", () => {
  const nodes = flowNodes([
    {
      id: "llm",
      type: "call_llm",
      x: 0,
      y: 0,
      params: { prompt: "summarize", system: "be terse", model: "gpt-5-codex", provider: "codex" },
    },
  ]);

  const out = serializeWorkflowDefinition(nodes, []);
  assertSerializedNodes(out.nodes, [
    {
      id: "llm",
      type: "call_llm",
      x: 0,
      y: 0,
      params: { prompt: "summarize", system: "be terse", model: "gpt-5-codex", provider: "codex" },
    },
  ]);
});

test("round-trips Generic Agent workspace mode without loss", () => {
  assert.equal(BLOCK_PARAM_KEYS.generic_agent.includes("workspaceMode"), true);
  const nodes = flowNodes([
    {
      id: "agent",
      type: "generic_agent",
      x: 0,
      y: 0,
      params: { prompt: "Summarize", workspaceMode: "none" },
    },
  ]);

  const out = serializeWorkflowDefinition(nodes, []);

  assert.deepEqual(out.nodes[0].params, { prompt: "Summarize", workspaceMode: "none" });
});

test("preserves a non-empty exact input binding map", () => {
  const nodes = flowNodes([
    {
      id: "llm",
      type: "call_llm",
      x: 0,
      y: 0,
      params: { prompt: "summarize" },
      inputs: {
        prompt: "steps.plan.output.plan",
        context: "trigger.ticket.description",
      },
    },
  ]);

  const out = serializeWorkflowDefinition(nodes, []);
  assert.deepEqual(out.nodes[0].inputs, {
    prompt: "steps.plan.output.plan",
    context: "trigger.ticket.description",
  });
});

test("emits only contract fields and rounds coordinates", () => {
  const nodes = flowNodes([
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      name: "Ticket assigned to AI",
      x: 40.4,
      y: 279.6,
      params: {},
      locked: true,
    },
    {
      id: "status",
      type: "update_ticket_status",
      name: "Update ticket status",
      x: 300,
      y: 280,
      params: { target: "ai_review", stray: "drop me" },
    },
  ]);
  const edges: FlowEdgeDef[] = [{ from: "trigger", to: "status" }];

  assert.deepEqual(serializeWorkflowDefinition(nodes, edges), {
    schemaVersion: 1,
    nodes: [
      {
        id: "trigger",
        type: "trigger_ticket_ai",
        name: "Ticket assigned to AI",
        x: 40,
        y: 280,
        params: {},
        inputs: {},
      },
      {
        id: "status",
        type: "update_ticket_status",
        name: "Update ticket status",
        x: 300,
        y: 280,
        params: { target: "ai_review" },
        inputs: {},
      },
    ],
    edges: [{ from: "trigger", to: "status" }],
  });
});

test("omits empty model and message params and undefined name", () => {
  const nodes = flowNodes([
    { id: "planning", type: "planning_agent", x: 0, y: 0, params: { model: "" } },
    { id: "review", type: "review_agent", x: 0, y: 0, params: { model: "claude-opus-4" } },
    { id: "slack", type: "send_slack_message", x: 0, y: 0, params: { message: "" } },
    { id: "checks", type: "run_pre_pr_checks", x: 0, y: 0, params: { maxFixCycles: 0 } },
  ]);

  const out = serializeWorkflowDefinition(nodes, []);
  assertSerializedNodes(out.nodes, [
    { id: "planning", type: "planning_agent", x: 0, y: 0, params: {} },
    { id: "review", type: "review_agent", x: 0, y: 0, params: { model: "claude-opus-4" } },
    { id: "slack", type: "send_slack_message", x: 0, y: 0, params: {} },
    { id: "checks", type: "run_pre_pr_checks", x: 0, y: 0, params: { maxFixCycles: 0 } },
  ]);
  assert.equal("name" in out.nodes[0], false);
});

test("emits provider for agent nodes when set and drops it when empty", () => {
  const nodes = flowNodes([
    {
      id: "planning",
      type: "planning_agent",
      x: 0,
      y: 0,
      params: { provider: "codex", model: "gpt-5-codex" },
    },
    { id: "implementation", type: "implementation_agent", x: 0, y: 0, params: { provider: "" } },
    { id: "review", type: "review_agent", x: 0, y: 0, params: { model: "claude-opus-4" } },
  ]);

  const out = serializeWorkflowDefinition(nodes, []);
  assertSerializedNodes(out.nodes, [
    {
      id: "planning",
      type: "planning_agent",
      x: 0,
      y: 0,
      params: { provider: "codex", model: "gpt-5-codex" },
    },
    { id: "implementation", type: "implementation_agent", x: 0, y: 0, params: {} },
    { id: "review", type: "review_agent", x: 0, y: 0, params: { model: "claude-opus-4" } },
  ]);
});

test("drops retired bespoke reference params while retaining supported arrays", () => {
  const nodes = flowNodes([
    {
      id: "fin",
      type: "finalize_workspace",
      x: 0,
      y: 0,
      params: {
        requiredChecks: ["checks-1", "checks-2"],
        legacyRequiredChecks: ["checks.with.dot"],
      },
    },
    {
      id: "approval",
      type: "send_plan_approval",
      x: 0,
      y: 0,
      params: { planFromStep: "plan" },
    },
    {
      id: "arthur",
      type: "arthur_injection_check",
      x: 0,
      y: 0,
      params: { contentFromStep: "plan" },
    },
    { id: "rc", type: "run_checks", x: 0, y: 0, params: { commands: [] } },
  ]);

  const out = serializeWorkflowDefinition(nodes, []);
  assertSerializedNodes(out.nodes, [
    {
      id: "fin",
      type: "finalize_workspace",
      x: 0,
      y: 0,
      params: { legacyRequiredChecks: ["checks.with.dot"] },
    },
    { id: "approval", type: "send_plan_approval", x: 0, y: 0, params: {} },
    { id: "arthur", type: "arthur_injection_check", x: 0, y: 0, params: {} },
    { id: "rc", type: "run_checks", x: 0, y: 0, params: {} },
  ]);
});

test("always emits fromPort for multi-port sources and omits it only for the single default port", () => {
  const nodes = flowNodes([
    { id: "branch", type: "branch", x: 0, y: 0, params: { condition: "steps.a.output.ok == true" } },
    { id: "yes", type: "open_pr", x: 0, y: 0, params: {} },
    { id: "no", type: "terminate", x: 0, y: 0, params: { terminalStatus: "failed" } },
    { id: "agent", type: "implementation_agent", x: 0, y: 0, params: {} },
    { id: "recover", type: "fix_agent", x: 0, y: 0, params: {} },
    { id: "done", type: "open_pr", x: 0, y: 0, params: {} },
  ]);
  const edges: FlowEdgeDef[] = [
    { from: "branch", to: "yes", fromPort: "true" },
    { from: "branch", to: "no", fromPort: "false" },
    { from: "agent", to: "done", fromPort: "out" },
    { from: "agent", to: "recover", fromPort: "failed" },
  ];

  const out = serializeWorkflowDefinition(nodes, edges);
  assert.deepEqual(out.edges, [
    { from: "branch", to: "yes", fromPort: "true" },
    { from: "branch", to: "no", fromPort: "false" },
    { from: "agent", to: "done" },
    { from: "agent", to: "recover", fromPort: "failed" },
  ]);
});

test("serializes a branch and loop graph with fromPort on every control edge", () => {
  const nodes = flowNodes([
    { id: "branch", type: "branch", x: 0, y: 0, params: { condition: "steps.a.output.ok == true" } },
    { id: "yes", type: "open_pr", x: 0, y: 0, params: {} },
    { id: "no", type: "terminate", x: 0, y: 0, params: { terminalStatus: "failed" } },
    { id: "loop", type: "loop", x: 0, y: 0, params: { maxAttempts: 3 } },
    { id: "body", type: "implementation_agent", x: 0, y: 0, params: {} },
    { id: "after", type: "open_pr", x: 0, y: 0, params: {} },
  ]);
  const edges: FlowEdgeDef[] = [
    { from: "branch", to: "yes", fromPort: "true" },
    { from: "branch", to: "no", fromPort: "false" },
    { from: "loop", to: "body", fromPort: "continue" },
    { from: "loop", to: "after", fromPort: "exhausted" },
  ];

  const out = serializeWorkflowDefinition(nodes, edges);
  assert.deepEqual(out.edges, [
    { from: "branch", to: "yes", fromPort: "true" },
    { from: "branch", to: "no", fromPort: "false" },
    { from: "loop", to: "body", fromPort: "continue" },
    { from: "loop", to: "after", fromPort: "exhausted" },
  ]);
  for (const edge of out.edges) {
    assert.equal(typeof edge.fromPort, "string");
  }
});

test("drops cleared, whitespace-only and empty required string params", () => {
  const nodes = flowNodes([
    { id: "term", type: "terminate", x: 0, y: 0, params: { terminalStatus: "failed", postComment: "" } },
    { id: "cmt", type: "post_ticket_comment", x: 0, y: 0, params: { body: "   " } },
    { id: "llm", type: "call_llm", x: 0, y: 0, params: { prompt: "", system: "" } },
  ]);

  const out = serializeWorkflowDefinition(nodes, []);
  assertSerializedNodes(out.nodes, [
    { id: "term", type: "terminate", x: 0, y: 0, params: { terminalStatus: "failed" } },
    { id: "cmt", type: "post_ticket_comment", x: 0, y: 0, params: {} },
    { id: "llm", type: "call_llm", x: 0, y: 0, params: {} },
  ]);
});

test("leaves legacy edges without fromPort byte-comparable", () => {
  const nodes = flowNodes([
    { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
    { id: "status", type: "update_ticket_status", x: 0, y: 0, params: { target: "ai_review" } },
  ]);
  const edges: FlowEdgeDef[] = [{ from: "trigger", to: "status" }];

  const out = serializeWorkflowDefinition(nodes, edges);
  assert.deepEqual(out.edges, [{ from: "trigger", to: "status" }]);
});

test("never emits provider for non-agent node types", () => {
  const nodes = flowNodes([
    {
      id: "status",
      type: "update_ticket_status",
      x: 0,
      y: 0,
      params: { target: "ai_review", provider: "codex" },
    },
    { id: "slack", type: "send_slack_message", x: 0, y: 0, params: { message: "hi", provider: "claude" } },
  ]);

  const out = serializeWorkflowDefinition(nodes, []);
  assertSerializedNodes(out.nodes, [
    { id: "status", type: "update_ticket_status", x: 0, y: 0, params: { target: "ai_review" } },
    { id: "slack", type: "send_slack_message", x: 0, y: 0, params: { message: "hi" } },
  ]);
});

test("preserves execution budgets when saving graph edits", () => {
  const budgets = { maxDurationMs: 60_000, maxTokens: 5_000, maxCostUsd: 2.5 };

  const out = serializeWorkflowDefinition([], [], budgets);

  assert.deepEqual(out.budgets, budgets);
});
