import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDefinition } from "@shared/contracts";

vi.mock("../../env.js", () => ({
  env: {
    ENABLE_REVIEW_PHASE: false,
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-test",
    CODEX_MODEL: "codex-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CODEX_API_KEY: "sk-codex-test",
    GITHUB_APP_ID: 1,
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_INSTALLATION_ID: 2,
    CHAT_SDK_SLACK_TOKEN: "slack-token",
    CHAT_SDK_CHANNEL_ID: "channel",
    GENAI_ENGINE_API_KEY: "arthur-key",
    GENAI_ENGINE_TRACE_ENDPOINT: "https://arthur.example/traces",
  },
}));
vi.mock("../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetCurrentVersion = vi.fn();
const mockGetDeployedVersion = vi.fn();
const mockGetDefinition = vi.fn();
const mockGetVersion = vi.fn();
const mockGetEnabled = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getCurrentWorkflowDefinitionVersion: (...args: unknown[]) => mockGetCurrentVersion(...args),
  getDeployedWorkflowDefinitionVersion: (...args: unknown[]) => mockGetDeployedVersion(...args),
  getWorkflowDefinition: (...args: unknown[]) => mockGetDefinition(...args),
  getWorkflowDefinitionVersion: (...args: unknown[]) => mockGetVersion(...args),
  getEnabledWorkflowDefinitionForTrigger: (...args: unknown[]) => mockGetEnabled(...args),
}));

const loggerError = vi.fn();
const loggerInfo = vi.fn();
vi.mock("../lib/logger.js", () => ({
  logger: {
    info: (...a: unknown[]) => loggerInfo(...a),
    warn: vi.fn(),
    error: (...a: unknown[]) => loggerError(...a),
  },
}));

import {
  loadWorkflowDefinition,
  loadWorkflowDefinitionFor,
  normalizeDefinitionForExecution,
} from "./definition-step.js";
import { defaultWorkflowDefinition } from "../workflow-definition/default.js";
import type { WorkflowDefinitionEdge, WorkflowDefinitionNode } from "@shared/contracts";

async function setEnv(partial: Record<string, unknown>) {
  const mod = (await import("../../env.js")) as unknown as { env: Record<string, unknown> };
  mod.env = { ...mod.env, ...partial };
}

async function resetEnv(enableReviewPhase: boolean) {
  await setEnv({
    ENABLE_REVIEW_PHASE: enableReviewPhase,
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-test",
    CODEX_MODEL: "codex-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CODEX_API_KEY: "sk-codex-test",
    GITHUB_APP_ID: 1,
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_INSTALLATION_ID: 2,
    CHAT_SDK_SLACK_TOKEN: "slack-token",
    CHAT_SDK_CHANNEL_ID: "channel",
    GENAI_ENGINE_API_KEY: "arthur-key",
    GENAI_ENGINE_TRACE_ENDPOINT: "https://arthur.example/traces",
  });
}

function row(definition: WorkflowDefinition, version = 3, definitionId = 1) {
  return {
    definitionId,
    version,
    definition,
    createdAt: new Date(),
    createdById: "u1",
    createdByLabel: "User One",
    restoredFromVersion: null,
  };
}

/** Wraps a version row as the enabled-definition lookup result. */
function enabled(definition: WorkflowDefinition, version = 3, definitionId = 1) {
  return { definition: { id: definitionId }, current: row(definition, version, definitionId) };
}

describe("loadWorkflowDefinition", () => {
  beforeEach(async () => {
    mockGetCurrentVersion.mockReset();
    mockGetDeployedVersion.mockReset();
    mockGetDefinition.mockReset();
    mockGetVersion.mockReset();
    mockGetEnabled.mockReset();
    loggerError.mockReset();
    loggerInfo.mockReset();
    await resetEnv(false);
  });

  it("fails closed when there is no enabled definition", async () => {
    mockGetEnabled.mockResolvedValue(null);
    const plan = await loadWorkflowDefinition();
    expect(plan).toBeNull();
  });

  it("does not synthesize a default solely because the review flag is on", async () => {
    await setEnv({ ENABLE_REVIEW_PHASE: true });
    mockGetEnabled.mockResolvedValue(null);
    const plan = await loadWorkflowDefinition();
    expect(plan).toBeNull();
  });

  it("uses the enabled definition matched by trigger type when the row is valid", async () => {
    mockGetEnabled.mockResolvedValue(enabled(defaultWorkflowDefinition({ includeReview: true }), 7, 3));
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBe(7);
    expect(plan.definitionId).toBe(3);
    expect(plan.reviewEnabled).toBe(true);
    expect(plan.nodes.map((n) => n.type)).toEqual([
      "trigger_ticket_ai",
      "planning_agent",
      "implementation_agent",
      "review_agent",
      "run_pre_pr_checks",
      "finalize_workspace",
      "open_pr",
      "send_slack_message",
      "update_ticket_status",
    ]);
    expect(mockGetEnabled).toHaveBeenCalledWith(expect.anything(), "trigger_ticket_ai");
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("preserves configured execution budgets in the loaded plan", async () => {
    const definition = {
      ...defaultWorkflowDefinition({ includeReview: false }),
      budgets: { maxDurationMs: 12_000, maxTokens: 500, maxCostUsd: 1.25 },
    };
    mockGetEnabled.mockResolvedValue(enabled(definition, 8, 4));

    const plan = await loadWorkflowDefinition();

    expect(plan.budgets).toEqual({ maxDurationMs: 12_000, maxTokens: 500, maxCostUsd: 1.25 });
  });

  it("reflects reviewEnabled=false for a valid stored definition without a review block", async () => {
    mockGetEnabled.mockResolvedValue(enabled(defaultWorkflowDefinition({ includeReview: false }), 4, 2));
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBe(4);
    expect(plan.definitionId).toBe(2);
    expect(plan.reviewEnabled).toBe(false);
  });

  it("fails closed and logs when the row fails schema validation", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled({ schemaVersion: 2, nodes: [], edges: [] } as unknown as WorkflowDefinition, 9, 5),
    );
    const plan = await loadWorkflowDefinition();
    expect(plan).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({ version: 9, definitionId: 5 });
  });

  it("fails closed when an eager store upgrade raises a deterministic Zod error", async () => {
    mockGetEnabled.mockRejectedValue(
      Object.assign(new Error("invalid stored definition"), {
        name: "ZodError",
        issues: [{ path: ["nodes", 0, "type"], message: "Unknown workflow block type." }],
      }),
    );

    const plan = await loadWorkflowDefinition();

    expect(plan).toBeNull();
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ issues: expect.stringContaining("Unknown workflow block type") }),
      "workflow_definition_invalid",
    );
  });

  it("does not swallow database or network read failures", async () => {
    mockGetEnabled.mockRejectedValue(new Error("database unavailable"));

    await expect(loadWorkflowDefinition()).rejects.toThrow("database unavailable");
  });

  it("fails closed and logs when the graph is invalid", async () => {
    const invalidGraph: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
        { id: "p", type: "planning_agent", x: 0, y: 0, params: {}, inputs: {} },
      ],
      edges: [],
    };
    mockGetEnabled.mockResolvedValue(enabled(invalidGraph, 12, 6));
    const plan = await loadWorkflowDefinition();
    expect(plan).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({ version: 12, definitionId: 6 });
  });

  it("fails closed and logs when a stored graph has invalid typed bindings", async () => {
    const invalidBinding: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
        { id: "approval", type: "send_plan_approval", x: 0, y: 0, params: {}, inputs: {} },
      ],
      edges: [{ from: "t", to: "approval" }],
    };
    mockGetEnabled.mockResolvedValue(enabled(invalidBinding, 13, 7));

    const plan = await loadWorkflowDefinition();

    expect(plan).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0].issues).toContain('missing required input "plan"');
  });

  it("keeps an already-deployed explicit legacy Arthur compatibility path loadable", async () => {
    const legacyCompatible: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
        { id: "fix", type: "fix_agent", x: 0, y: 0, params: {}, inputs: {} },
        {
          id: "check",
          type: "arthur_injection_check",
          x: 0,
          y: 0,
          params: { legacyContentFromStep: "fix" },
          inputs: {},
        },
      ],
      edges: [
        { from: "t", to: "fix" },
        { from: "fix", to: "check" },
      ],
    };
    mockGetEnabled.mockResolvedValue(enabled(legacyCompatible, 14, 8));

    const plan = await loadWorkflowDefinition();

    expect(plan.definitionId).toBe(8);
    expect(plan.nodes.find((node) => node.id === "check")?.params).toEqual({
      legacyContentFromStep: "fix",
    });
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("upgrades and loads an execution-only legacy Finalize gate", async () => {
    const legacyCompatible: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
        {
          id: "finalize",
          type: "finalize_workspace",
          x: 0,
          y: 0,
          params: { requiredChecks: ["missing legacy check"] },
          inputs: {},
        },
      ],
      edges: [{ from: "t", to: "finalize" }],
    };
    mockGetEnabled.mockResolvedValue(enabled(legacyCompatible, 15, 9));

    const plan = await loadWorkflowDefinition();

    expect(plan.definitionId).toBe(9);
    expect(plan.nodes.find((node) => node.id === "finalize")?.params).toEqual({
      legacyRequiredChecks: ["missing legacy check"],
    });
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("keeps a deployed definition pinned when current credentials become unavailable", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled(defaultWorkflowDefinition({ includeReview: false }), 16, 10),
    );
    await setEnv({
      ANTHROPIC_API_KEY: undefined,
      CODEX_API_KEY: undefined,
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_INSTALLATION_ID: undefined,
      CHAT_SDK_SLACK_TOKEN: undefined,
      CHAT_SDK_CHANNEL_ID: undefined,
    });

    const plan = await loadWorkflowDefinition();

    expect(plan.definitionId).toBe(10);
    expect(plan.version).toBe(16);
    expect(loggerError).not.toHaveBeenCalled();
  });
});

describe("loadWorkflowDefinitionFor", () => {
  beforeEach(async () => {
    mockGetCurrentVersion.mockReset();
    mockGetDeployedVersion.mockReset();
    mockGetDefinition.mockReset();
    mockGetVersion.mockReset();
    mockGetEnabled.mockReset();
    loggerError.mockReset();
    loggerInfo.mockReset();
    await resetEnv(true);
  });

  it("loads a pinned definition by id", async () => {
    mockGetDeployedVersion.mockResolvedValue(row(defaultWorkflowDefinition({ includeReview: true }), 3, 55));
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai", 55);
    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(3);
    expect(plan!.definitionId).toBe(55);
    expect(mockGetDeployedVersion).toHaveBeenCalledWith(expect.anything(), 55);
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });

  it("loads the pinned version when an explicit version is given", async () => {
    mockGetVersion.mockResolvedValue(row(defaultWorkflowDefinition({ includeReview: true }), 4, 55));
    const plan = await loadWorkflowDefinitionFor("trigger_plan_approved", 55, 4);
    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(4);
    expect(plan!.definitionId).toBe(55);
    expect(mockGetVersion).toHaveBeenCalledWith(expect.anything(), 55, 4);
    expect(mockGetDeployedVersion).not.toHaveBeenCalled();
  });

  it("returns null when the pinned version is missing for a non-ticket trigger", async () => {
    mockGetVersion.mockResolvedValue(null);
    const plan = await loadWorkflowDefinitionFor("trigger_plan_approved", 55, 99);
    expect(plan).toBeNull();
    expect(mockGetVersion).toHaveBeenCalledWith(expect.anything(), 55, 99);
  });

  it("returns null for a non-ticket trigger with no enabled definition", async () => {
    mockGetEnabled.mockResolvedValue(null);
    const plan = await loadWorkflowDefinitionFor("planning_agent");
    expect(plan).toBeNull();
  });

  it("loads PR #118-style static-valued PR and ticket chains without redundant bindings", async () => {
    const staticDefinition: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: "ticket", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
        {
          id: "generic",
          type: "generic_agent",
          x: 1,
          y: 0,
          params: { prompt: "Summarize the ticket" },
          inputs: {},
        },
        {
          id: "llm",
          type: "call_llm",
          x: 2,
          y: 0,
          params: { prompt: "Write a status", system: "Be concise" },
          inputs: {},
        },
        {
          id: "ticket-comment",
          type: "post_ticket_comment",
          x: 3,
          y: 0,
          params: { body: "Work started" },
          inputs: {},
        },
        {
          id: "ticket-status",
          type: "update_ticket_status",
          x: 4,
          y: 0,
          params: { target: "ai_review" },
          inputs: {},
        },
        {
          id: "slack",
          type: "send_slack_message",
          x: 5,
          y: 0,
          params: { message: "" },
          inputs: {},
        },
        {
          id: "pr",
          type: "trigger_pr_created",
          x: 0,
          y: 1,
          params: { providers: ["github"], onlyWorkflowOwned: true },
          inputs: {},
        },
        {
          id: "pr-comment",
          type: "post_pr_comment",
          x: 1,
          y: 1,
          params: { body: "Review started", target: "primary" },
          inputs: {},
        },
      ],
      edges: [
        { from: "ticket", to: "generic" },
        { from: "generic", to: "llm" },
        { from: "llm", to: "ticket-comment" },
        { from: "ticket-comment", to: "ticket-status" },
        { from: "ticket-status", to: "slack" },
        { from: "pr", to: "pr-comment" },
      ],
    };
    mockGetEnabled.mockResolvedValue(enabled(staticDefinition, 17, 11));

    const plan = await loadWorkflowDefinitionFor("trigger_pr_created");

    expect(plan).not.toBeNull();
    expect(plan?.definitionId).toBe(11);
    expect(plan?.version).toBe(17);
    for (const id of [
      "generic",
      "llm",
      "ticket-comment",
      "ticket-status",
      "slack",
      "pr-comment",
    ]) {
      expect(plan?.nodes.find((node) => node.id === id)?.inputs, id).toEqual({});
    }
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("does not fall back when an arbitrary pinned ticket definition is missing", async () => {
    mockGetDeployedVersion.mockResolvedValue(null);
    mockGetDefinition.mockResolvedValue(null);
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai", 999);
    expect(plan).toBeNull();
  });

  it("uses the built-in graph only for the explicit fallback row", async () => {
    mockGetEnabled.mockResolvedValue({ definition: { id: 1, builtinFallback: true }, current: null });
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
    expect(plan).toMatchObject({ version: null, definitionId: null, reviewEnabled: true });
  });

  it("keeps an explicitly pinned fallback immutable when the row is deployed later", async () => {
    await resetEnv(false);
    mockGetDeployedVersion.mockResolvedValue(
      row(defaultWorkflowDefinition({ includeReview: true }), 9, 1),
    );

    const plan = await loadWorkflowDefinitionFor(
      "trigger_ticket_ai",
      1,
      "builtin_fallback" as never,
    );

    expect(plan).toMatchObject({ version: null, definitionId: 1, reviewEnabled: false });
    expect(mockGetDefinition).not.toHaveBeenCalled();
    expect(mockGetDeployedVersion).not.toHaveBeenCalled();
    expect(mockGetVersion).not.toHaveBeenCalled();
  });
});

describe("normalizeDefinitionForExecution", () => {
  function node(
    id: string,
    type: WorkflowDefinitionNode["type"],
    params: WorkflowDefinitionNode["params"] = {},
  ): WorkflowDefinitionNode {
    return { id, type, x: 0, y: 0, params, inputs: {} };
  }

  it("does not inject virtual Prepare blocks for specialized agents", () => {
    const nodes = [
      node("t", "trigger_ticket_ai"),
      node("plan", "planning_agent"),
      node("impl", "implementation_agent"),
      node("fix", "fix_agent"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "t", to: "plan" },
      { from: "plan", to: "impl" },
      { from: "impl", to: "fix" },
    ];

    expect(normalizeDefinitionForExecution(nodes, edges)).toEqual({ nodes, edges });
  });

  it("keeps a graph whose explicit prepare_workspace precedes the sandbox block untouched", () => {
    const nodes = [
      node("t", "trigger_ticket_ai"),
      node("n1", "prepare_workspace"),
      node("n2", "generic_agent", { prompt: "do it" }),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "t", to: "n1" },
      { from: "n1", to: "n2" },
    ];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.nodes).toBe(nodes);
    expect(normalized.edges).toBe(edges);
  });

  it("preserves a modular workspace consumer without Prepare for a clear runtime error", () => {
    const nodes = [
      node("t", "trigger_ticket_ai"),
      node("checks", "run_checks"),
    ];
    const edges: WorkflowDefinitionEdge[] = [{ from: "t", to: "checks" }];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.nodes).toBe(nodes);
    expect(normalized.edges).toBe(edges);
  });

  it("preserves the authored edge port exactly", () => {
    const nodes = [node("t", "trigger_ticket_ai"), node("p", "planning_agent")];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "t", to: "p", fromPort: "out" },
    ];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.edges).toBe(edges);
    expect(normalized.edges).toEqual(edges);
  });
});
