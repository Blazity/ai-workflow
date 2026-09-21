import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWorkflowInput } from "../agent-input.js";

/**
 * What the Send message block reports, through a whole run.
 *
 * The block is inline in the executor closure, so the only way to see what it
 * decides is to run the graph: the mapping from "did the message arrive" to
 * `ok` or `skipped` is exactly what a stored branch off `skipped` acts on, and
 * a test that called a helper directly would see neither the `pr_ready` mode
 * that every parameterless stored node uses nor the recorded block state.
 *
 * The harness is the one `agent-integration-unavailable.test.ts` established:
 * the steps around the executor are mocked, the executor itself is real.
 */
const telemetry = vi.hoisted(() => ({
  markRunFailedOnSelfMove: vi.fn(async () => undefined),
  recordRunStatusReason: vi.fn(async () => undefined),
  recordRunUsage: vi.fn(async () => undefined),
  finalizeRunAnalysisUsage: vi.fn(async () => undefined),
  sanitizeRunStepsForDiagnosticError: vi.fn(
    (_steps: unknown, executionError: unknown) => {
      throw executionError;
    },
  ),
}));
const jira = vi.hoisted(() => ({
  postComment: vi.fn(async (_ticketKey: string, _comment: string) => {}),
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
}));
/** The messaging capability, which answers whether the message went out. */
const messaging = vi.hoisted(() => ({
  notifyForTicket: vi.fn(
    async (_ticketKey: string, _event: { kind: string }): Promise<unknown> => ({
      delivered: true,
    }),
  ),
}));
const publication = vi.hoisted(() => ({
  open: vi.fn(async () => ({
    status: "published" as const,
    repositories: [
      {
        provider: "github" as const,
        repoPath: "acme/api",
        branchName: "ai/aiw-902-api",
        defaultBranch: "main",
        expectedHead: "before-api",
        pushedHead: "after-api",
      },
      {
        provider: "gitlab" as const,
        repoPath: "acme/web",
        branchName: "ai/aiw-902-web",
        defaultBranch: "main",
        expectedHead: "before-web",
        pushedHead: "after-web",
      },
    ],
    prs: [
      {
        provider: "github" as const,
        repoPath: "acme/api",
        id: 128,
        url: "https://github.com/acme/api/pull/128",
        branch: "ai/aiw-902-api",
        isNew: true,
      },
      {
        provider: "gitlab" as const,
        repoPath: "acme/web",
        id: 44,
        url: "https://gitlab.com/acme/web/-/merge_requests/44",
        branch: "ai/aiw-902-web",
        isNew: true,
      },
    ],
  })),
}));

/** The graph this run's trigger resolves to, swapped per test. */
/** What the deployment's messaging connection looks like right now. */
const live = vi.hoisted(() => ({ fingerprint: "fp-1" }));
/** What the engine handed the adapter factory, call by call. */
const adapterPins = vi.hoisted(() => ({ seen: [] as unknown[] }));
const graph = vi.hoisted(() => ({
  nodes: [] as Array<Record<string, unknown>>,
}));
const edges = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));
/** What the run-load step found out about this deployment's integrations. */
const plan = vi.hoisted(() => ({
  blocker: null as
    | { integrationId: string; reason: "disconnected" | "disabled"; message: string }
    | null,
  /** What the run recorded about the messaging provider when it started. */
  pins: [] as { integrationId: string; configFingerprint: string }[],
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
    definition: { schemaVersion: 2, nodes: graph.nodes, edges: edges.value },
    version: 4,
    definitionId: 11,
    // The v1 projection the trigger selection and the prompt step read.
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      params: node.configuration,
    })),
    edges: edges.value,
    reviewEnabled: false,
    integrationPins: plan.pins,
    ...(plan.blocker ? { integrationBlocker: plan.blocker } : {}),
  })),
}));
vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
// The deployment's messaging provider as the run finds it at send time. The
// pin check compares this against what the plan recorded at the run's start.
vi.mock("../../services/integrations/runtime.js", async (importOriginal) => ({
  // The pin comparison itself is the real one: a test that mocked it would
  // prove the engine calls something, not that a moved provider stops a run.
  checkIntegrationPin: (await importOriginal<
    typeof import("../../services/integrations/runtime.js")
  >()).checkIntegrationPin,
  resolveUsableIntegrations: vi.fn(async () => ({
    readable: true,
    usable: [
      {
        manifest: { id: "acmechat", name: "Acme Chat", capabilities: ["messaging"] },
        runtime: { capabilities: { messaging: () => ({ notifyForTicket: async () => ({ delivered: true }) }) } },
        ctx: {},
      },
    ],
    states: new Map([
      [
        "acmechat",
        {
          integrationId: "acmechat",
          status: "connected",
          connection: "connected",
          enabled: true,
          usable: true,
          failure: null,
          pin: { integrationId: "acmechat", configFingerprint: live.fingerprint },
        },
      ],
    ]),
  })),
}));
// Which agent harness a node would run under. It reads the organization and the
// stored profile selection, and no node here runs an agent.
vi.mock("../definition/harness-profile-runtime.js", () => ({
  resolveConnectedHarnessRuntimesForDefinition: async () => ({}),
}));
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
  listConnectedRepositoryCatalogKeys: async () => [
    { provider: "github", path: "acme/api", enabled: true },
    { provider: "gitlab", path: "acme/web", enabled: true },
  ],
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
  createAdapters: (_vcsTarget?: unknown, pins?: unknown) => ({
    ...(((): Record<string, never> => {
      adapterPins.seen.push(pins);
      return {};
    })()),
    issueTracker: {
      postComment: jira.postComment,
      fetchTicket: jira.fetchTicket,
      moveTicket: jira.moveTicket,
      updateLabels: jira.updateLabels,
    },
    messaging: { notifyForTicket: messaging.notifyForTicket },
  }),
}));
vi.mock("../steps/workspace-publication.js", () => ({
  openPullRequestsForPublication: publication.open,
}));
vi.mock("../blocks/executors.generated.js", () => ({
  BLOCK_EXECUTORS: {
    finalize_workspace: async (
      _node: unknown,
      _steps: unknown,
      ctx: { publication: unknown },
    ) => {
      const repositories = (await publication.open()).repositories;
      ctx.publication = { status: "finalized", repositories, prs: [] };
      return { kind: "next", output: { status: "finalized", repositories } };
    },
  },
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
vi.mock("../../infra/logger.js", () => {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return { logger };
});

const { agentWorkflow } = await import("../agent-workflow.js");

const entry: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "ticket:jira:AIW-902",
  ticketKey: "AIW-902",
  ownerToken: "owner:send-message",
  continuation: { kind: "clarification", clarificationRequestId: "clar-902" },
  definitionId: 11,
  definitionVersion: 4,
};

function node(id: string, type: string, configuration: Record<string, unknown>) {
  return { id, type, x: 0, y: 0, configuration, inputs: {}, additionalInputs: [] };
}

/**
 * The shape an author builds when they want the run to act on a message that
 * did not go out: Send message, a Branch on its status, and two ends. Which
 * end the run reached is what `skipped` is FOR, and the skipped end posts the
 * block's reason on the ticket, so the reason is observable where a person
 * reads it rather than only in a value nothing shows.
 */
function graphWith(configuration: Record<string, unknown>, type = "send_message") {
  return [
    node("trigger", "trigger_ticket_ai", {}),
    node("notify", type, configuration),
    node("gate", "branch", {
      combinator: "all",
      conditions: [
        { reference: "steps.notify.output.status", operator: "equals", value: "skipped" },
      ],
    }),
    node("not-sent", "terminate", {
      terminalStatus: "done",
      postComment: "Not sent: {{data:steps.notify.output.reason}}",
    }),
    node("sent", "terminate", { terminalStatus: "done", postComment: "Sent" }),
  ];
}

const EDGES = [
  { id: "e1", from: "trigger", to: "notify" },
  { id: "e2", from: "notify", to: "gate" },
  { id: "e3", from: "gate", to: "not-sent", fromPort: "true" },
  { id: "e4", from: "gate", to: "sent", fromPort: "false" },
];

beforeEach(() => {
  vi.clearAllMocks();
  plan.blocker = null;
  plan.pins = [];
  live.fingerprint = "fp-1";
  adapterPins.seen = [];
  edges.value = EDGES;
  messaging.notifyForTicket.mockResolvedValue({ delivered: true });
  publication.open.mockClear();
});

/** The events the block sent, without the run's own lifecycle notifications. */
function blockMessages(): unknown[] {
  return messaging.notifyForTicket.mock.calls
    .map((call) => call[1])
    .filter((event) => event.kind === "note" || event.kind === "pr_ready");
}

describe("Send message, through a run", () => {
  it("reports ok only for a message that arrived, and the run takes the sent path", async () => {
    graph.nodes = graphWith({ sendOn: "always", message: "deploying now" });

    await expect(agentWorkflow(entry)).resolves.not.toThrow();

    assertSent("deploying now");
    // Nothing on the skipped path ran, so nothing told the ticket it was not
    // sent.
    expect(notSentComments()).toEqual([]);
    expect(sentComments()).toEqual(["Sent"]);
  });

  it("keeps a run suspended before this deploy on the path it was already taking", async () => {
    // `notifyTicket` is a step, and a run that completed one before this
    // deploy replays with what it recorded then: nothing. Reading `.delivered`
    // off that would fail the run on the way back, and reporting `skipped`
    // would send it down a branch it had never been on. It reported ok before,
    // so it reports ok now.
    messaging.notifyForTicket.mockResolvedValue(undefined);
    graph.nodes = graphWith({ sendOn: "always", message: "deploying now" });

    // No `catch` here: the run has to finish. Reading `.delivered` off the
    // recorded nothing fails the block, and the person whose run it is sees it
    // die on the way back from a deploy they were not part of.
    await expect(agentWorkflow(entry)).resolves.not.toThrow();

    assertSent("deploying now");
    expect(notSentComments()).toEqual([]);
  });

  it("reports skipped with the reason when nothing was delivered, and the run carries on", async () => {
    // The defect this replaces: notifyForTicket could not fail by contract, so
    // the block reported ok for a message nobody ever saw and a graph that
    // branched on skipped could never take that branch.
    messaging.notifyForTicket.mockResolvedValue({
      delivered: false,
      reason: "no messaging provider is connected on this deployment",
    });
    graph.nodes = graphWith({ sendOn: "always", message: "deploying now" });

    await expect(agentWorkflow(entry)).resolves.not.toThrow();

    // It was sent, it did not arrive, and the run went on to the branch the
    // author built for exactly this, which told the ticket why.
    assertSent("deploying now");
    expect(notSentComments()).toEqual([
      "Not sent: no messaging provider is connected on this deployment",
    ]);
  });

  it("skips a pr_ready message when the run published no pull request", async () => {
    // The default mode of every parameterless stored node.
    graph.nodes = graphWith({});

    await expect(agentWorkflow(entry)).resolves.not.toThrow();

    expect(blockMessages()).toEqual([]);
    expect(notSentComments()).toEqual([
      "Not sent: no pull request has been published in this run yet",
    ]);
  });

  it("skips an empty message rather than posting nothing", async () => {
    graph.nodes = graphWith({ sendOn: "always", message: "   " });

    await expect(agentWorkflow(entry)).resolves.not.toThrow();

    expect(blockMessages()).toEqual([]);
    expect(notSentComments()).toEqual([
      "Not sent: the message is empty, so there was nothing to send",
    ]);
  });

  it("publishes every pull request, the usage report and extra text, then takes the ok edge", async () => {
    graph.nodes = [
      node("trigger", "trigger_ticket_ai", {}),
      node("finalize", "finalize_workspace", {}),
      {
        ...node("publish", "open_pr", {}),
        inputs: {
          repositories: {
            kind: "reference",
            reference: "steps.finalize.output.repositories",
          },
        },
      },
      ...graphWith({ sendOn: "pr_ready", message: "Release notes are ready." }).slice(1),
    ];
    edges.value = [
      { id: "e1", from: "trigger", to: "finalize" },
      { id: "e2", from: "finalize", to: "publish" },
      { id: "e3", from: "publish", to: "notify" },
      { id: "e4", from: "notify", to: "gate" },
      { id: "e5", from: "gate", to: "not-sent", fromPort: "true" },
      { id: "e6", from: "gate", to: "sent", fromPort: "false" },
    ];

    await expect(agentWorkflow(entry)).resolves.not.toThrow();

    expect(publication.open).toHaveBeenCalledTimes(2);
    expect(blockMessages()).toEqual([
      {
        kind: "pr_ready",
        prs: [
          {
            provider: "github",
            repoPath: "acme/api",
            id: 128,
            headSha: "after-api",
            url: "https://github.com/acme/api/pull/128",
          },
          {
            provider: "gitlab",
            repoPath: "acme/web",
            id: 44,
            headSha: "after-web",
            url: "https://gitlab.com/acme/web/-/merge_requests/44",
          },
        ],
        usageReport: "Usage: $0.00 total | ",
        extraText: "Release notes are ready.",
      },
    ]);
    expect(notSentComments()).toEqual([]);
    expect(sentComments()).toEqual(["Sent"]);
  });

  it("stops the run when the provider it pinned moved under it", async () => {
    // Which deliveries are refused is messaging.test.ts's subject. This is the
    // block's half: a refusal that says the provider moved is not a message
    // that failed to send, so the run stops with what an admin acts on rather
    // than branching off `skipped` as if nothing were wrong.
    messaging.notifyForTicket.mockResolvedValue({
      delivered: false,
      reason: "Acme Chat's configuration changed after this run started",
      moved: "reconfigured",
    });
    graph.nodes = graphWith({ sendOn: "always", message: "deploying now" });

    await expect(agentWorkflow(entry)).rejects.toThrow(
      /Acme Chat's configuration changed after this run started/,
    );

    // The run's own lifecycle notifications still went out, which is the line:
    // a block reports and can stop a run, a notification does neither.
    expect(
      messaging.notifyForTicket.mock.calls.map((call) => (call[1] as { kind: string }).kind),
    ).toEqual(["started", "note", "failed"]);
  });

  it("hands the step the pins the run recorded", async () => {
    plan.pins = [{ integrationId: "acmechat", configFingerprint: "fp-1" }];
    graph.nodes = graphWith({ sendOn: "always", message: "deploying now" });

    await expect(agentWorkflow(entry)).resolves.not.toThrow();

    assertSent("deploying now");
    // Without this the pin never reaches the resolution that compares it, and
    // every check downstream is decoration.
    expect(adapterPins.seen).toContainEqual([
      { integrationId: "acmechat", configFingerprint: "fp-1" },
    ]);
    // And the lifecycle notifications went out unpinned, which is what keeps a
    // moved provider from turning a notification into a run failure.
    expect(adapterPins.seen).toContainEqual(undefined);
  });

  it("runs a plan recorded before the block was renamed", async () => {
    // A run suspended before S9 replays a plan that still names
    // send_slack_message. It has to finish, not die on a type nothing answers.
    graph.nodes = graphWith({ sendOn: "always", message: "deploying now" }, "send_slack_message");

    await expect(agentWorkflow(entry)).resolves.not.toThrow();

    assertSent("deploying now");
    expect(notSentComments()).toEqual([]);
  });
});

function assertSent(text: string): void {
  expect(blockMessages()).toEqual([{ kind: "note", text }]);
}

/** What the skipped branch told the ticket, which is where the reason lands. */
function notSentComments(): string[] {
  return jira.postComment.mock.calls
    .map((call) => String(call[1]))
    .filter((comment) => comment.startsWith("Not sent:"));
}

function sentComments(): string[] {
  return jira.postComment.mock.calls
    .map((call) => String(call[1]))
    .filter((comment) => comment === "Sent");
}
