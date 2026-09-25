import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A deployment with nothing connected: the secrets it knows are its
// environment's (same stand-in as agent-integration-unavailable.test.ts).
vi.mock("../../services/integrations/secret-values.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/integrations/secret-values.js")>();
  const { environmentSecretValues } = await import("../../run-observability/configured-secrets.js");
  return { ...actual, knownSecretValues: async () => environmentSecretValues() };
});
import type { AgentWorkflowInput } from "../agent-input.js";

/**
 * A pull request run whose pull request moved on before the run reached it.
 *
 * Production run wrun_01M3B9X8SHGCE0KQK4YJ0F71VW (definition 12, 2026-09-25):
 * the pull request was closed 7 seconds before create_pr_check looked at it.
 * The run reported "An external service could not complete this block",
 * runs.diagnose told the operator to check the AI provider's status page, and
 * the bot commented "failed on this pull request" on a closed pull request.
 * Nothing had failed. A newer commit is the same story: the review of an older
 * commit is simply no longer wanted.
 */
const telemetry = vi.hoisted(() => ({
  markRunFailedOnSelfMove: vi.fn(async () => undefined),
  recordRunStatusReason: vi.fn(async () => undefined),
  recordRunUsage: vi.fn(async (_usage: Record<string, unknown>) => undefined),
  finalizeRunAnalysisUsage: vi.fn(async () => undefined),
  sanitizeRunStepsForDiagnosticError: vi.fn(
    (_steps: unknown, executionError: unknown) => ({ executionError }),
  ),
}));
const messaging = vi.hoisted(() => ({
  postComment: vi.fn(async () => {}),
  notifyForTicket: vi.fn(async () => {}),
  moveTicket: vi.fn(async () => {}),
}));
/** The pull request as the provider reports it when the run looks. */
const provider = vi.hoisted(() => ({
  head: { headSha: "abc123", state: "open", baseRef: "main" } as {
    headSha: string;
    state: "open" | "closed" | "merged";
    baseRef: string;
  },
  getPRHead: vi.fn(),
  createGateStatus: vi.fn(async () => ({ provider: "github", id: 1 })),
  updateGateStatus: vi.fn(async () => {}),
  postRunFailureNote: vi.fn(async () => {}),
}));
const checks = vi.hoisted(() => ({
  insertPrCheck: vi.fn(async () => {}),
}));

const SNAPSHOT = JSON.parse(
  readFileSync(
    new URL(
      "../../workflow-graph-suites/scenarios/snapshots/post-pr-review-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { schemaVersion: 2; nodes: Array<Record<string, unknown>>; edges: unknown[] };

vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  createHook: vi.fn(),
  getWorkflowMetadata: () => ({ workflowRunId: "run-moved-on" }),
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
  // The deployed post-PR review graph, as definition 12 runs it.
  loadWorkflowDefinitionFor: vi.fn(async () => ({
    definition: SNAPSHOT,
    version: 7,
    definitionId: 12,
    definitionName: "Post-PR review",
    // The runtime shape definition-step hands the engine (toRuntimeShape).
    nodes: SNAPSHOT.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      x: node.x,
      y: node.y,
      params: node.configuration,
      inputs: {},
    })),
    edges: (SNAPSHOT.edges as Array<{ from: string; to: string; fromPort?: string }>).map(
      ({ from, to, fromPort }) => (fromPort ? { from, to, fromPort } : { from, to }),
    ),
    reviewEnabled: false,
    integrationPins: [],
  })),
}));
// The review agents downstream never run in these cases, so the profiles they
// would resolve are not this file's concern (they read a database it lacks).
vi.mock("../definition/harness-profile-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../definition/harness-profile-runtime.js")>()),
  resolveConnectedHarnessRuntimesForDefinition: vi.fn(async () => ({})),
}));
vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../../db/repositories/settings.js", () => ({
  readAllConnectedSettings: async () => [],
}));
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
    activated: true,
    activatedAt: "2026-09-12T00:00:00.000Z",
    activatedById: "user_admin",
    activatedByLabel: "Ada",
  }),
  listConnectedRepositoryCatalogKeys: async () => ["github:acme/app"],
}));
vi.mock("../steps/workflow-ticket.js", () => ({
  resolveWorkflowTicketStep: vi.fn(async (input: AgentWorkflowInput) => ({
    id: input.subjectKey,
    identifier: input.subjectKey,
    title: "External change",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
    trackerStatus: "",
    attachments: [],
  })),
}));
vi.mock("../../engine/support/adapters.js", () => ({
  createAdapters: () => ({
    issueTrackerResolution: {
      ok: true,
      adapter: { postComment: messaging.postComment, moveTicket: messaging.moveTicket },
    },
    messaging: { notifyForTicket: messaging.notifyForTicket },
  }),
}));
vi.mock("../../engine/support/vcs-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engine/support/vcs-runtime.js")>();
  const adapter = () => ({
    getPRHead: provider.getPRHead,
    createGateStatus: provider.createGateStatus,
    updateGateStatus: provider.updateGateStatus,
    postRunFailureNote: provider.postRunFailureNote,
  });
  return {
    ...actual,
    createRepositoryVCS: adapter,
    resolveRepositoryVCS: async () => adapter(),
    createRepositoryVcsRuntime: () => ({ vcs: adapter(), adapter: async () => adapter() }),
  };
});
vi.mock("../../db/repositories/pr-external-resources.js", () => {
  const repository = {
    findPrCheckForAttempt: vi.fn(async () => undefined),
    findPrCheckById: vi.fn(async () => undefined),
    insertPrCheck: checks.insertPrCheck,
    markPrCheckPending: vi.fn(async () => {}),
    markPrCheckCreationFailed: vi.fn(async () => {}),
    markPrCheckClosing: vi.fn(async () => {}),
    completePrCheck: vi.fn(async () => {}),
    markReconciledPrCheckPending: vi.fn(async () => {}),
    markPrCheckRetry: vi.fn(async () => {}),
    listOpenPrChecks: vi.fn(async () => []),
    listReconcilePrChecks: vi.fn(async () => []),
    listRunStatuses: vi.fn(async () => []),
    listPrReviewPublicationsForRound: vi.fn(async () => []),
    insertPrReviewPublication: vi.fn(async () => {}),
    markPrReviewPublicationFailed: vi.fn(async () => {}),
    markPrReviewPublicationPublished: vi.fn(async () => {}),
  };
  return {
    createPrExternalResourcesRepository: () => repository,
    createConnectedPrExternalResourcesRepository: () => repository,
  };
});
vi.mock("../../db/repositories/active-runs.js", () => ({
  assertActiveRunOwner: vi.fn(async () => {}),
  assertConnectedActiveRunOwner: vi.fn(async () => {}),
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
vi.mock("../../infra/logger.js", () => {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  return { logger };
});

const { agentWorkflow } = await import("../agent-workflow.js");

const entry: AgentWorkflowInput = {
  kind: "pr_trigger",
  triggerType: "trigger_pr_ready",
  subjectKey: "pr:github:acme/app#349",
  ownerToken: "owner:moved-on",
  definitionId: 12,
  definitionVersion: 7,
  scope: "any",
  pr: {
    provider: "github",
    repoPath: "acme/app",
    prNumber: 349,
    prUrl: "https://github.com/acme/app/pull/349",
    headRef: "feature/manual-change",
    headSha: "abc123",
    baseRef: "main",
    title: "feat: manual change",
    author: "octocat",
    isDraft: false,
  },
};

/** The one end-of-run write: the run's own status and why. */
function finalRecord(): Record<string, unknown> {
  const calls = telemetry.recordRunUsage.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.getPRHead.mockImplementation(async () => provider.head);
});

describe("a pull request run whose pull request moved on before its check existed", () => {
  it("stops as superseded when a newer commit arrived, and says so without blaming a provider", async () => {
    provider.head = { headSha: "def4567890", state: "open", baseRef: "main" };

    // The run ends; it does not fail. A failed Workflow run is what made the
    // dashboard and every run listing count this as an error.
    await expect(agentWorkflow(entry)).resolves.toBeUndefined();

    const record = finalRecord();
    expect(record.status).toBe("blocked");
    expect(record.statusReason).toEqual({
      text: expect.stringContaining("moved on to a newer commit (def4567)"),
      code: "pull_request_moved_on.new_commit",
    });
    const reason = (record.statusReason as { text: string }).text;
    // This graph starts on pull request updates, so the newer commit has a run
    // of its own coming, and the reason says so.
    expect(reason).toContain("its own run");
    expect(reason).not.toMatch(/external service|provider|Diagnostic ID/i);

    // No check was created for a commit nobody will review, and nobody was told
    // this run failed: not the pull request, not a ticket, not chat.
    expect(provider.createGateStatus).not.toHaveBeenCalled();
    expect(checks.insertPrCheck).not.toHaveBeenCalled();
    expect(provider.postRunFailureNote).not.toHaveBeenCalled();
    expect(messaging.postComment).not.toHaveBeenCalled();
    expect(messaging.notifyForTicket).not.toHaveBeenCalled();
    expect(telemetry.markRunFailedOnSelfMove).not.toHaveBeenCalled();
  });

  it("stops the same way when the pull request was closed, and names the closing instead", async () => {
    // What actually happened to wrun_01M3B9X8SHGCE0KQK4YJ0F71VW.
    provider.head = { headSha: "abc123", state: "closed", baseRef: "main" };

    await expect(agentWorkflow(entry)).resolves.toBeUndefined();

    const record = finalRecord();
    expect(record.status).toBe("blocked");
    expect(record.statusReason).toEqual({
      text: expect.stringContaining("was closed"),
      code: "pull_request_moved_on.closed",
    });
    expect(provider.postRunFailureNote).not.toHaveBeenCalled();
    expect(provider.createGateStatus).not.toHaveBeenCalled();
  });

  it("still fails loudly when the provider itself breaks while creating the check", async () => {
    // The guard above must not swallow a real provider fault: the head is
    // current and GitHub refuses the check.
    provider.head = { headSha: "abc123", state: "open", baseRef: "main" };
    provider.createGateStatus.mockRejectedValueOnce(new Error("GitHub is down."));

    await agentWorkflow(entry).catch(() => undefined);

    const record = finalRecord();
    expect(record.status).toBe("failed");
    expect(provider.postRunFailureNote).toHaveBeenCalled();
  });
});
