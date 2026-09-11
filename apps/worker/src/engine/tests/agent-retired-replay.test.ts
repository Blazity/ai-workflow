import { beforeEach, describe, expect, it, vi } from "vitest";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import type { AgentWorkflowInput } from "../agent-input.js";

const telemetry = vi.hoisted(() => ({
  markRunFailedOnSelfMove: vi.fn(async () => undefined),
  recordRunStatusReason: vi.fn(async () => undefined),
  recordRunUsage: vi.fn(async () => undefined),
  finalizeRunAnalysisUsage: vi.fn(async () => undefined),
  sanitizeRunStepsForDiagnosticError: vi.fn(
    (_steps: unknown, executionError: unknown) => ({ executionError }),
  ),
}));
const jira = vi.hoisted(() => ({
  postComment: vi.fn(async () => {}),
}));

vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  createHook: vi.fn(),
  getWorkflowMetadata: () => ({ workflowRunId: "run-retired-replay" }),
}));
vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    AGENT_KIND: "codex",
    CLAUDE_MODEL: "claude-test",
    CODEX_MODEL: "codex-test",
    COLUMN_AI: "AI",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
    JIRA_BASE_URL: "https://jira.example",
  },
  getConfiguredVcsProviders: vi.fn(),
}));
vi.mock("../steps/run-ownership-steps.js", () => ({
  bindWorkflowCandidateStep: vi.fn(async () => true),
  acknowledgeManualDispatchStep: vi.fn(async () => undefined),
  acknowledgeApprovalDispatchStep: vi.fn(async () => undefined),
  acknowledgePrTriggerDispatchStep: vi.fn(async () => true),
  acknowledgeWebhookDispatchStep: vi.fn(async () => true),
  acknowledgeScheduleDispatchStep: vi.fn(async () => true),
  acknowledgePendingTriggerStep: vi.fn(async () => undefined),
}));
vi.mock("../steps/prompts-step.js", () => ({
  loadPrompts: vi.fn(async () => ({})),
}));
vi.mock("../steps/definition-step.js", () => ({
  loadWorkflowDefinitionFor: vi.fn(async () => ({
    definition: {
      schemaVersion: 1,
      nodes: [{ id: "historical", type: "unknown" }],
      edges: [],
    },
    version: 3,
    definitionId: 9,
    nodes: [],
    edges: [],
    reviewEnabled: false,
  })),
}));
vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../steps/workflow-ticket.js", () => ({
  resolveWorkflowTicketStep: vi.fn(async (input: AgentWorkflowInput) => ({
    id: input.ticketKey ?? input.subjectKey,
    identifier: input.ticketKey ?? input.subjectKey,
    title: "Historical schedule",
    description: "This replay cannot run.",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
    trackerStatus: "AI",
    attachments: [],
  })),
}));
vi.mock("../../engine/support/adapters.js", () => ({
  createAdapters: () => ({ issueTracker: { postComment: jira.postComment } }),
}));
vi.mock("../../db/repositories/active-runs.js", () => ({
  assertActiveRunOwner: vi.fn(async () => {}),
  assertConnectedActiveRunOwner: vi.fn(async () => {}),
}));
vi.mock("../../db/repositories/runs/telemetry.js", () => ({
  markRunFailedOnSelfMove: telemetry.markRunFailedOnSelfMove,
  markRunSucceededOnSelfMove: vi.fn(),
  recordBlockStatuses: vi.fn(),
  recordRunStatusReason: telemetry.recordRunStatusReason,
  recordRunUsage: telemetry.recordRunUsage,
  recordConnectedRunUsage: telemetry.recordRunUsage,
  recordConnectedBlockStatuses: vi.fn(),
  recordConnectedRunStatusReason: telemetry.recordRunStatusReason,
  markConnectedRunFailedOnSelfMove: telemetry.markRunFailedOnSelfMove,
  markConnectedRunSucceededOnSelfMove: vi.fn(),
}));
vi.mock("../../run-analysis/persistence.js", () => ({
  finalizeRunAnalysisUsage: telemetry.finalizeRunAnalysisUsage,
  finalizeConnectedRunAnalysisUsage: telemetry.finalizeRunAnalysisUsage,
}));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({}) }));
vi.mock("../../engine/support/collect-run-detail.js", () => ({
  captureRunStepsBestEffort: vi.fn(async () => []),
  sanitizeRunStepsForDiagnosticError: telemetry.sanitizeRunStepsForDiagnosticError,
}));
vi.mock("../../infra/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { agentWorkflow } = await import("../agent-workflow.js");

const entry: AgentWorkflowInput = {
  kind: "schedule",
  scheduleId: "sch_legacy",
  definitionId: 9,
  definitionVersion: 3,
  nodeId: "schedule",
  subjectKey: "schedule:sch_legacy",
  ownerToken: "owner:retired",
  scheduledFor: "2026-09-10T08:00:00.000Z",
  taskTitle: "Historical schedule",
  taskDescription: "This replay cannot run.",
};

describe("retired workflow replay telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jira.postComment.mockImplementation(async () => {});
  });

  it("records zero usage, the harness manifest, and the retirement execution error through the workflow body", async () => {
    await expect(agentWorkflow(entry)).resolves.toBeUndefined();

    expect(telemetry.markRunFailedOnSelfMove).toHaveBeenCalledOnce();
    expect(telemetry.recordRunStatusReason).toHaveBeenCalledWith(
      "run-retired-replay",
      RETIRED_SCHEMA_MESSAGE,
      { kind: "failure" },
    );
    expect(telemetry.recordRunUsage).toHaveBeenCalledOnce();
    expect(telemetry.recordRunUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-retired-replay",
        status: "failed",
        statusReason: expect.stringContaining(RETIRED_SCHEMA_MESSAGE),
        costUsd: 0,
        costKnown: true,
        tokensInput: 0,
        tokensCached: 0,
        tokensOutput: 0,
        phases: {},
        harnessManifests: [],
      }),
    );
    expect(telemetry.sanitizeRunStepsForDiagnosticError).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        message: expect.stringContaining(RETIRED_SCHEMA_MESSAGE),
        code: expect.stringMatching(/^AIW-DIAG-/),
      }),
    );
  });

  it("persists retirement telemetry when the Jira failure comment rethrows a control error", async () => {
    jira.postComment.mockRejectedValueOnce({
      name: "ActiveRunOwnerError",
      message: "run ownership changed before the Jira comment",
    });
    const ticketEntry: AgentWorkflowInput = {
      kind: "ticket",
      subjectKey: "ticket:jira:AIW-343",
      ticketKey: "AIW-343",
      ownerToken: "owner:retired",
      continuation: {
        kind: "clarification",
        clarificationRequestId: "clar-retired",
      },
      definitionId: 9,
      definitionVersion: 3,
    };

    await expect(agentWorkflow(ticketEntry)).rejects.toMatchObject({
      name: "ActiveRunOwnerError",
    });

    expect(jira.postComment).toHaveBeenCalledWith(
      "AIW-343",
      RETIRED_SCHEMA_MESSAGE,
    );
    expect(telemetry.recordRunUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-retired-replay",
        status: "failed",
        statusReason: expect.stringContaining(RETIRED_SCHEMA_MESSAGE),
        costUsd: 0,
        costKnown: true,
        tokensInput: 0,
        tokensCached: 0,
        tokensOutput: 0,
        harnessManifests: [],
      }),
    );
  });
});
