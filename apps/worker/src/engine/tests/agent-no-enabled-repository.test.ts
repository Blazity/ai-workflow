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
import type { AgentWorkflowInput } from "../agent-input.js";

/**
 * A ticket run on an activated catalog that enables nothing.
 *
 * A ticket trigger is not one of the four paths the catalog decides dispatch
 * on, so the run starts whatever the catalog says. What it does next depends
 * on the DEPLOYED graph: a graph that needs a checkout is refused before it
 * prepares one, and a triage graph is left alone, because it never wanted a
 * repository and failing it would fail work the catalog has no opinion about.
 */
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
  // The refusal this file is about ends in the transparent-failure exit, which
  // parks the ticket and notifies. Both read the adapters, so a mock that
  // carries only postComment makes the failure path throw inside a test we
  // treat as green, and a real fault there would look exactly the same.
  fetchTicket: vi.fn(async (id: string) => ({
    id,
    identifier: id,
    title: "Something to do",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
    trackerStatus: "AI",
    attachments: [],
  })),
  moveTicket: vi.fn(async () => {}),
  updateLabels: vi.fn(async () => {}),
  notifyForTicket: vi.fn(async () => {}),
}));
/** The graph this run's trigger resolves to, swapped per test. */
const graph = vi.hoisted(() => ({
  nodes: [] as Array<Record<string, unknown>>,
}));

vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  createHook: vi.fn(),
  getWorkflowMetadata: () => ({ workflowRunId: "run-no-enabled-repository" }),
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
vi.mock("../steps/prompts-step.js", () => ({ loadPrompts: vi.fn(async () => ({})) }));
vi.mock("../steps/definition-step.js", () => ({
  loadWorkflowDefinitionFor: vi.fn(async () => ({
    // schemaVersion 2, so the retirement exit above this leaves it alone and
    // the run reaches the catalog question rather than the retired one.
    definition: { schemaVersion: 2, nodes: graph.nodes, edges: [] },
    version: 4,
    definitionId: 11,
    nodes: [],
    edges: [],
    reviewEnabled: false,
  })),
}));
vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
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
// The catalog decides access and enables nothing: the state every test here is
// about.
vi.mock("../../db/repositories/repository-catalog.js", () => ({
  getConnectedRepositoryCatalogStateRow: async () => ({
    activated: true,
    activatedAt: "2026-09-12T00:00:00.000Z",
    activatedById: "user_admin",
    activatedByLabel: "Ada",
  }),
  listConnectedRepositoryCatalogKeys: async () => [],
}));
vi.mock("../steps/workflow-ticket.js", () => ({
  resolveWorkflowTicketStep: vi.fn(async (input: AgentWorkflowInput) => ({
    id: input.ticketKey ?? input.subjectKey,
    identifier: input.ticketKey ?? input.subjectKey,
    title: "Something to do",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
    trackerStatus: "AI",
    attachments: [],
  })),
}));
vi.mock("../../engine/support/adapters.js", () => ({
  createAdapters: () => ({
    issueTracker: {
      postComment: jira.postComment,
      fetchTicket: jira.fetchTicket,
      moveTicket: jira.moveTicket,
      updateLabels: jira.updateLabels,
    },
    messaging: { notifyForTicket: jira.notifyForTicket },
  }),
}));
vi.mock("../../db/repositories/active-runs.js", () => ({
  assertActiveRunOwner: vi.fn(async () => {}),
  assertConnectedActiveRunOwner: vi.fn(async () => {}),
  // Read by the park the failure exit performs, which this file reaches on
  // every case: the refusal IS a failure exit.
  assertActiveRunOwnerState: vi.fn(async () => {}),
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
const { NO_ENABLED_REPOSITORY_MESSAGE } = await import(
  "../steps/run-start-settings.js"
);

/** A continuation entry, so the one-off pickup comment stays out of the way and
 *  every comment this suite sees is one the refusal decided to post. */
const entry: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "ticket:jira:AIW-900",
  ticketKey: "AIW-900",
  ownerToken: "owner:no-enabled",
  continuation: { kind: "clarification", clarificationRequestId: "clar-900" },
  definitionId: 11,
  definitionVersion: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  jira.postComment.mockImplementation(async () => {});
});

describe("a ticket run against a catalog that enables nothing", () => {
  it("refuses a graph that needs a checkout, and tells the ticket which switch to reach for", async () => {
    graph.nodes = [
      { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, configuration: {} },
      { id: "prepare", type: "prepare_workspace", x: 0, y: 1, configuration: {} },
      { id: "impl", type: "implementation_agent", x: 0, y: 2, configuration: {} },
    ];

    await agentWorkflow(entry);

    expect(jira.postComment).toHaveBeenCalledWith(
      "AIW-900",
      NO_ENABLED_REPOSITORY_MESSAGE,
    );
    expect(telemetry.markRunFailedOnSelfMove).toHaveBeenCalledOnce();
    // The reason sentence IS the record: there is no separate failure kind
    // column behind it.
    expect(telemetry.recordRunStatusReason).toHaveBeenCalledWith(
      "run-no-enabled-repository",
      NO_ENABLED_REPOSITORY_MESSAGE,
      { kind: "failure" },
    );
  });

  it("leaves a triage graph alone, because it never wanted a repository", async () => {
    graph.nodes = [
      { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, configuration: {} },
      { id: "llm", type: "call_llm", x: 0, y: 1, configuration: {} },
      { id: "comment", type: "post_ticket_comment", x: 0, y: 2, configuration: {} },
      { id: "status", type: "update_ticket_status", x: 0, y: 3, configuration: {} },
    ];

    // It runs on past the catalog question and fails or finishes on its own
    // terms further down, which is not what this asserts: what matters is that
    // the catalog did not stop it.
    await agentWorkflow(entry).catch(() => undefined);

    expect(jira.postComment).not.toHaveBeenCalledWith(
      "AIW-900",
      NO_ENABLED_REPOSITORY_MESSAGE,
    );
    expect(telemetry.recordRunStatusReason).not.toHaveBeenCalledWith(
      "run-no-enabled-repository",
      NO_ENABLED_REPOSITORY_MESSAGE,
      { kind: "failure" },
    );
  });
});
