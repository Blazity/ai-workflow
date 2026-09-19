import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWorkflowInput } from "../agent-input.js";

/**
 * A ticket run whose workflow uses an integration nobody can reach.
 *
 * Somebody disconnected it, or disabled it, since the workflow was published.
 * The person waiting on the ticket gets a failed run and one sentence naming
 * the integration, not silence and not a workspace and an agent invocation
 * nobody needed. This is the automatic-dispatch audience: nobody is looking at
 * a modal, so the ticket comment is the whole answer.
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
/** What the run-load step found out about this deployment's integrations. */
const plan = vi.hoisted(() => ({
  blocker: null as
    | { integrationId: string; reason: "disconnected" | "disabled"; message: string }
    | null,
}));

vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  createHook: vi.fn(),
  getWorkflowMetadata: () => ({ workflowRunId: "run-integration-unavailable" }),
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
  // The plan carries what the run-load step read about this deployment's
  // integrations: the blocker when one the graph uses cannot run, and the pins
  // otherwise. Both are frozen there so a replay takes the same branch.
  loadWorkflowDefinitionFor: vi.fn(async () => ({
    definition: { schemaVersion: 2, nodes: graph.nodes, edges: [] },
    version: 4,
    definitionId: 11,
    nodes: [],
    edges: [],
    reviewEnabled: false,
    integrationPins: [],
    ...(plan.blocker ? { integrationBlocker: plan.blocker } : {}),
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
// One enabled repository, so the catalog refusal this file is not about never
// fires and the only exit under test is the integration one.
vi.mock("../../db/repositories/repository-catalog.js", () => ({
  getConnectedRepositoryCatalogStateRow: async () => ({
    activated: true,
    activatedAt: "2026-09-12T00:00:00.000Z",
    activatedById: "user_admin",
    activatedByLabel: "Ada",
  }),
  listConnectedRepositoryCatalogKeys: async () => ["github:acme/app"],
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

/** A continuation entry, so the one-off pickup comment stays out of the way and
 *  every comment this suite sees is one the refusal decided to post. */
const entry: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "ticket:jira:AIW-901",
  ticketKey: "AIW-901",
  ownerToken: "owner:integration-unavailable",
  continuation: { kind: "clarification", clarificationRequestId: "clar-901" },
  definitionId: 11,
  definitionVersion: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  plan.blocker = null;
  jira.postComment.mockImplementation(async () => {});
});

const UNAVAILABLE =
  "Acme Notify is disabled. Enable it on the Integrations page to use this block.";

describe("a ticket run whose integration cannot be reached", () => {
  it("fails before any work, records the reason and comments it on the ticket", async () => {
    plan.blocker = { integrationId: "acmenotify", reason: "disabled", message: UNAVAILABLE };
    graph.nodes = [
      { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, configuration: {} },
      { id: "announce", type: "acmenotify_announce", x: 0, y: 1, configuration: {} },
    ];

    await agentWorkflow(entry);

    // What a person reads is the sentence and only the sentence. The code is
    // not copy and must never leak into a ticket comment.
    expect(jira.postComment).toHaveBeenCalledWith("AIW-901", UNAVAILABLE);
    expect(telemetry.markRunFailedOnSelfMove).toHaveBeenCalledOnce();
    // What a machine reads is the code, recorded beside the sentence in the one
    // write. S3 asks this column which of the three reasons it was; asking the
    // sentence would break the first time we improve the wording.
    expect(telemetry.recordRunStatusReason).toHaveBeenCalledWith(
      "run-integration-unavailable",
      { text: UNAVAILABLE, code: "integration_unavailable.disabled" },
      { kind: "failure" },
    );
    // The ticket goes back where a person can pick it up again.
    expect(jira.moveTicket).toHaveBeenCalled();
  });

  it("names the reason it actually found, not one fixed code for the family", async () => {
    // Three reasons, three codes. Collapsing them would leave S3 able to say
    // "an integration was unavailable" and nothing an admin could act on.
    plan.blocker = {
      integrationId: "acmenotify",
      reason: "disconnected",
      message: "Acme Notify is not connected.",
    };
    graph.nodes = [
      { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, configuration: {} },
      { id: "announce", type: "acmenotify_announce", x: 0, y: 1, configuration: {} },
    ];

    await agentWorkflow(entry);

    expect(telemetry.recordRunStatusReason).toHaveBeenCalledWith(
      "run-integration-unavailable",
      { text: "Acme Notify is not connected.", code: "integration_unavailable.disconnected" },
      { kind: "failure" },
    );
  });

  it("leaves a run alone when every integration its graph uses is usable", async () => {
    plan.blocker = null;
    graph.nodes = [
      { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, configuration: {} },
      { id: "announce", type: "acmenotify_announce", x: 0, y: 1, configuration: {} },
    ];

    // It goes on and ends on its own terms further down, which is not what this
    // asserts: what matters is that the integration check did not stop it.
    await agentWorkflow(entry).catch(() => undefined);

    expect(jira.postComment).not.toHaveBeenCalledWith("AIW-901", UNAVAILABLE);
    expect(telemetry.recordRunStatusReason).not.toHaveBeenCalledWith(
      "run-integration-unavailable",
      { text: UNAVAILABLE, code: "integration_unavailable.disabled" },
      { kind: "failure" },
    );
  });
});
