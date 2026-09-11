import { describe, it, expect, vi, beforeEach } from "vitest";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import type { WorkflowDefinitionV2 } from "@shared/contracts";

vi.mock("../../infra/vcs-config.js", () => ({
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
vi.mock("../../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetCurrentVersion = vi.fn();
const mockGetDeployedVersion = vi.fn();
const mockGetDefinition = vi.fn();
const mockGetVersion = vi.fn();
const mockGetEnabled = vi.fn();
vi.mock("../../db/repositories/definitions.js", () => ({
  getCurrentWorkflowDefinitionVersion: (...args: unknown[]) => mockGetCurrentVersion(...args),
  getDeployedWorkflowDefinitionVersion: (...args: unknown[]) => mockGetDeployedVersion(...args),
  getWorkflowDefinition: (...args: unknown[]) => mockGetDefinition(...args),
  getWorkflowDefinitionVersion: (...args: unknown[]) => mockGetVersion(...args),
  getEnabledWorkflowDefinitionForTrigger: (...args: unknown[]) => mockGetEnabled(...args),
}));

const loggerError = vi.fn();
const loggerInfo = vi.fn();
vi.mock("../../infra/logger.js", () => ({
  logger: {
    info: (...a: unknown[]) => loggerInfo(...a),
    warn: vi.fn(),
    error: (...a: unknown[]) => loggerError(...a),
  },
}));

import { loadWorkflowDefinitionFor } from "./definition-step.js";
import { defaultWorkflowDefinitionV2 } from "../../workflow-definition/default.js";

async function setEnv(partial: Record<string, unknown>) {
  const mod = (await import("../../infra/vcs-config.js")) as unknown as { env: Record<string, unknown> };
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

function row(definition: WorkflowDefinitionV2, version = 3, definitionId = 1) {
  return {
    definitionId,
    version,
    schema: "v2" as const,
    definition,
    createdAt: new Date(),
    createdById: "u1",
    createdByLabel: "User One",
    restoredFromVersion: null,
  };
}

function legacyRow(definition: unknown, version = 3, definitionId = 1) {
  return {
    definitionId,
    version,
    schema: "legacy-v1" as const,
    definition,
    createdAt: new Date(),
    createdById: "u1",
    createdByLabel: "User One",
    restoredFromVersion: null,
  };
}

/** Wraps a version row as the enabled-definition lookup result. */
function enabled(definition: WorkflowDefinitionV2, version = 3, definitionId = 1) {
  return { definition: { id: definitionId }, current: row(definition, version, definitionId) };
}

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
    mockGetDeployedVersion.mockResolvedValue(row(defaultWorkflowDefinitionV2({ includeReview: true }), 3, 55));
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai", 55);
    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(3);
    expect(plan!.definitionId).toBe(55);
    expect(mockGetDeployedVersion).toHaveBeenCalledWith(expect.anything(), 55);
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });

  it("loads the pinned version when an explicit version is given", async () => {
    mockGetVersion.mockResolvedValue(row(defaultWorkflowDefinitionV2({ includeReview: true }), 4, 55));
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

  it("does not fall back when an arbitrary pinned ticket definition is missing", async () => {
    mockGetDeployedVersion.mockResolvedValue(null);
    mockGetDefinition.mockResolvedValue(null);
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai", 999);
    expect(plan).toBeNull();
  });

  it("uses the built-in graph only for the explicit fallback row", async () => {
    mockGetEnabled.mockResolvedValue({ definition: { id: 1 }, current: null });
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
    expect(plan).toMatchObject({ version: null, definitionId: null, reviewEnabled: true });
  });

  it("uses the configured Codex provider for the built-in fallback", async () => {
    await setEnv({ AGENT_KIND: "codex" });
    mockGetEnabled.mockResolvedValue({ definition: { id: 1 }, current: null });

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan?.definition.nodes.find((node) => node.id === "planning")?.configuration).toMatchObject({
      harnessProfile: { profileId: "builtin-codex", version: 2 },
    });
  });

  it("fails transparently for a deployed legacy-v1 version", async () => {
    mockGetDeployedVersion.mockResolvedValue(
      legacyRow({
        schemaVersion: 1,
        nodes: [{ id: "  historical node" }],
        edges: [{ from: "", to: 42 }],
      }),
    );

    await expect(loadWorkflowDefinitionFor("trigger_ticket_ai", 1)).rejects.toThrow(
      RETIRED_SCHEMA_MESSAGE,
    );
  });

  it("keeps an explicitly pinned fallback immutable when the row is deployed later", async () => {
    await resetEnv(false);
    mockGetDeployedVersion.mockResolvedValue(
      row(defaultWorkflowDefinitionV2({ includeReview: true }), 9, 1),
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

describe("loadWorkflowDefinitionFor, ticket trigger", () => {
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
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
    expect(plan).toBeNull();
  });

  it("does not synthesize a default solely because the review flag is on", async () => {
    await setEnv({ ENABLE_REVIEW_PHASE: true });
    mockGetEnabled.mockResolvedValue(null);
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
    expect(plan).toBeNull();
  });

  it("uses the enabled definition matched by trigger type when the row is valid", async () => {
    mockGetEnabled.mockResolvedValue(enabled(defaultWorkflowDefinitionV2({ includeReview: true }), 7, 3));
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(7);
    expect(plan!.definitionId).toBe(3);
    expect(plan!.reviewEnabled).toBe(true);
    expect(plan!.nodes.map((n) => n.type)).toEqual([
      "trigger_ticket_ai",
      "prepare_workspace",
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
      ...defaultWorkflowDefinitionV2({ includeReview: false }),
      budgets: { maxDurationMs: 12_000, maxTokens: 500, maxCostUsd: 1.25 },
    };
    mockGetEnabled.mockResolvedValue(enabled(definition, 8, 4));

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan).not.toBeNull();
    expect(plan!.budgets).toEqual({ maxDurationMs: 12_000, maxTokens: 500, maxCostUsd: 1.25 });
  });

  it("preserves a pinned repository scope in the loaded plan", async () => {
    const repositoryScope = {
      repositories: [
        { provider: "github" as const, repoPath: "Acme/Web" },
        { provider: "gitlab" as const, repoPath: "acme/group/api" },
      ],
      providers: ["github" as const, "gitlab" as const],
    };
    const definition = {
      ...defaultWorkflowDefinitionV2({ includeReview: false }),
      repositoryScope,
    };
    mockGetEnabled.mockResolvedValue(enabled(definition, 8, 4));

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan).not.toBeNull();
    expect(plan!.repositoryScope).toEqual(repositoryScope);
  });

  it("leaves repositoryScope absent for a definition without a pin", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled(defaultWorkflowDefinitionV2({ includeReview: false }), 8, 4),
    );

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan).not.toBeNull();
    expect(plan!.repositoryScope).toBeUndefined();
    expect("repositoryScope" in plan!).toBe(false);
  });

  it("preserves a pinned repository scope on a v2 plan", async () => {
    const repositoryScope = { providers: ["gitlab" as const] };
    const definition: WorkflowDefinitionV2 = {
      ...defaultWorkflowDefinitionV2({ includeReview: false }),
      repositoryScope,
    };
    mockGetEnabled.mockResolvedValue(enabled(definition, 11, 6));

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan).not.toBeNull();
    expect(plan!.repositoryScope).toEqual(repositoryScope);
  });

  it("reflects reviewEnabled=false for a valid stored definition without a review block", async () => {
    mockGetEnabled.mockResolvedValue(enabled(defaultWorkflowDefinitionV2({ includeReview: false }), 4, 2));
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(4);
    expect(plan!.definitionId).toBe(2);
    expect(plan!.reviewEnabled).toBe(false);
  });

  it("loads an exact v2 plan without flattening its persisted definition", async () => {
    const definition: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [
        {
          id: "ticket",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
        {
          id: "finish",
          type: "terminate",
          x: 240,
          y: 0,
          configuration: {
            terminalStatus: "done",
            postComment: "Completed by the v2 runtime.",
          },
          inputs: {},
          additionalInputs: [],
        },
      ],
      edges: [
        {
          id: "ticket-finish",
          from: "ticket",
          to: "finish",
        },
      ],
    };
    mockGetEnabled.mockResolvedValue(
      enabled(definition, 9, 5),
    );
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      definition,
      version: 9,
      definitionId: 5,
      reviewEnabled: false,
    });
    expect(plan!.nodes).toEqual([
      {
        id: "ticket",
        type: "trigger_ticket_ai",
        x: 0,
        y: 0,
        params: {},
        inputs: {},
      },
      {
        id: "finish",
        type: "terminate",
        x: 240,
        y: 0,
        params: {
          terminalStatus: "done",
          postComment: "Completed by the v2 runtime.",
        },
        inputs: {},
      },
    ]);
    expect(plan!.edges).toEqual([{ from: "ticket", to: "finish" }]);
    expect(
      (plan!.definition as WorkflowDefinitionV2).edges[0]?.id,
    ).toBe("ticket-finish");
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("preserves a pinned built-in profile for executor-boundary resolution", async () => {
    const definition = defaultWorkflowDefinitionV2({
      includeReview: false,
      provider: "codex",
    });
    mockGetEnabled.mockResolvedValue(enabled(definition, 10, 6));

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan).not.toBeNull();
    expect(
      plan!.nodes.find((node) => node.id === "planning")?.params,
    ).toEqual({
      harnessProfile: { profileId: "builtin-codex", version: 2 },
      prompt: "{{prompt:research-plan@1}}",
    });
    expect(
      (plan!.definition as WorkflowDefinitionV2).nodes.find(
        (node) => node.id === "planning",
      )?.configuration,
    ).toEqual({
      harnessProfile: { profileId: "builtin-codex", version: 2 },
      prompt: "{{prompt:research-plan@1}}",
    });
  });

  it("fails closed when an eager store upgrade raises a deterministic Zod error", async () => {
    mockGetEnabled.mockRejectedValue(
      Object.assign(new Error("invalid stored definition"), {
        name: "ZodError",
        issues: [{ path: ["nodes", 0, "type"], message: "Unknown workflow block type." }],
      }),
    );

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan).toBeNull();
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ issues: expect.stringContaining("Unknown workflow block type") }),
      "workflow_definition_invalid",
    );
  });

  it("does not swallow database or network read failures", async () => {
    mockGetEnabled.mockRejectedValue(new Error("database unavailable"));

    await expect(loadWorkflowDefinitionFor("trigger_ticket_ai")).rejects.toThrow("database unavailable");
  });

  it("fails closed and logs when the graph is invalid", async () => {
    const invalidGraph: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [
        {
          id: "t",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
        {
          id: "p",
          type: "planning_agent",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
      ],
      edges: [],
    };
    mockGetEnabled.mockResolvedValue(enabled(invalidGraph, 12, 6));
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
    expect(plan).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({ version: 12, definitionId: 6 });
  });

  it("fails closed and logs when a stored graph has invalid typed bindings", async () => {
    const invalidBinding: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [
        {
          id: "t",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
        {
          id: "approval",
          type: "send_plan_approval",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
      ],
      edges: [{ id: "t-approval", from: "t", to: "approval" }],
    };
    mockGetEnabled.mockResolvedValue(enabled(invalidBinding, 13, 7));

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0].issues).toContain('missing required input "plan"');
  });

  it("keeps a deployed definition pinned when current credentials become unavailable", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled(defaultWorkflowDefinitionV2({ includeReview: false }), 16, 10),
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

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan).not.toBeNull();
    expect(plan!.definitionId).toBe(10);
    expect(plan!.version).toBe(16);
    expect(loggerError).not.toHaveBeenCalled();
  });
});
