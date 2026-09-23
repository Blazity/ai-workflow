import { beforeEach, describe, expect, it, vi } from "vitest";

// A deployment with nothing connected: the secrets it knows are its
// environment's. This suite is about something else, and the real source reads
// the integration settings from a database it does not have
// (services/integrations/secret-values.test.ts proves that read).
vi.mock("../../services/integrations/secret-values.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/integrations/secret-values.js")>();
  const { environmentSecretValues } = await import("../../run-observability/configured-secrets.js");
  return { ...actual, knownSecretValues: async () => environmentSecretValues() };
});
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
// The workflow body's first step reads the deployment's settings and catalog.
// This suite is about retirement telemetry, so it answers as an untouched
// deployment does: nothing stored, catalog never activated.
vi.mock("../../db/repositories/settings.js", () => ({
  readAllConnectedSettings: async () => [],
}));
// The run start reads the subject's work scope beside the settings, and this
// file's db client is a bare object. One read for the whole record, so a fact
// added to that picture never reaches this file again. No record: what a
// subject that has never been decided on looks like, which is every subject in
// these cases.
vi.mock("../../db/repositories/work-scope.js", () => ({
  readConnectedWorkScopeFacts: async () => ({
    scope: null,
    selectionAnswered: false,
    answeredRepositoryKeys: [],
    narrowingAnswered: false,
    answeredQuestion: null,
  }),
}));
vi.mock("../../db/repositories/repository-catalog.js", () => ({
  getConnectedRepositoryCatalogStateRow: async () => ({
    activated: false,
    activatedAt: null,
    activatedById: null,
    activatedByLabel: null,
  }),
  listConnectedRepositoryCatalogKeys: async () => [],
}));
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
  createAdapters: () => ({ issueTrackerResolution: { ok: true, adapter: { postComment: jira.postComment }  }}),
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
      // The deployment's known secrets, which the step errors are redacted with.
      expect.any(Array),
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
