import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeWorkflowDefinition } from "./serialize.ts";
import type { FlowEdgeDef, FlowNodeDef } from "../flows.ts";

test("emits only contract fields and rounds coordinates", () => {
  const nodes: FlowNodeDef[] = [
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
  ];
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
      },
      {
        id: "status",
        type: "update_ticket_status",
        name: "Update ticket status",
        x: 300,
        y: 280,
        params: { target: "ai_review" },
      },
    ],
    edges: [{ from: "trigger", to: "status" }],
  });
});

test("omits empty model and message params and undefined name", () => {
  const nodes: FlowNodeDef[] = [
    { id: "planning", type: "planning_agent", x: 0, y: 0, params: { model: "" } },
    { id: "review", type: "review_agent", x: 0, y: 0, params: { model: "claude-opus-4" } },
    { id: "slack", type: "send_slack_message", x: 0, y: 0, params: { message: "" } },
    { id: "checks", type: "run_pre_pr_checks", x: 0, y: 0, params: { maxFixCycles: 0 } },
  ];

  const out = serializeWorkflowDefinition(nodes, []);
  assert.deepEqual(out.nodes, [
    { id: "planning", type: "planning_agent", x: 0, y: 0, params: {} },
    { id: "review", type: "review_agent", x: 0, y: 0, params: { model: "claude-opus-4" } },
    { id: "slack", type: "send_slack_message", x: 0, y: 0, params: {} },
    { id: "checks", type: "run_pre_pr_checks", x: 0, y: 0, params: { maxFixCycles: 0 } },
  ]);
  assert.equal("name" in out.nodes[0], false);
});

test("emits provider for agent nodes when set and drops it when empty", () => {
  const nodes: FlowNodeDef[] = [
    {
      id: "planning",
      type: "planning_agent",
      x: 0,
      y: 0,
      params: { provider: "codex", model: "gpt-5-codex" },
    },
    { id: "implementation", type: "implementation_agent", x: 0, y: 0, params: { provider: "" } },
    { id: "review", type: "review_agent", x: 0, y: 0, params: { model: "claude-opus-4" } },
  ];

  const out = serializeWorkflowDefinition(nodes, []);
  assert.deepEqual(out.nodes, [
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

test("emits array params and drops empty arrays", () => {
  const nodes: FlowNodeDef[] = [
    {
      id: "fin",
      type: "finalize_workspace",
      x: 0,
      y: 0,
      params: { requiredChecks: ["checks-1", "checks-2"] },
    },
    { id: "rc", type: "run_checks", x: 0, y: 0, params: { commands: [] } },
  ];

  const out = serializeWorkflowDefinition(nodes, []);
  assert.deepEqual(out.nodes, [
    {
      id: "fin",
      type: "finalize_workspace",
      x: 0,
      y: 0,
      params: { requiredChecks: ["checks-1", "checks-2"] },
    },
    { id: "rc", type: "run_checks", x: 0, y: 0, params: {} },
  ]);
});

test("never emits provider for non-agent node types", () => {
  const nodes: FlowNodeDef[] = [
    {
      id: "status",
      type: "update_ticket_status",
      x: 0,
      y: 0,
      params: { target: "ai_review", provider: "codex" },
    },
    { id: "slack", type: "send_slack_message", x: 0, y: 0, params: { message: "hi", provider: "claude" } },
  ];

  const out = serializeWorkflowDefinition(nodes, []);
  assert.deepEqual(out.nodes, [
    { id: "status", type: "update_ticket_status", x: 0, y: 0, params: { target: "ai_review" } },
    { id: "slack", type: "send_slack_message", x: 0, y: 0, params: { message: "hi" } },
  ]);
});
