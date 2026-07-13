import { createApp, toWebHandler } from "h3";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { TriggerEvent } from "../lib/trigger-events.js";

// One file, four source areas. vi.mock is hoisted and file-scoped, so we mock
// the union of every dependency once. The env module (apps/worker/env.ts) is
// shared by all areas; we keep a single mutable object and poke properties.
const H = vi.hoisted(() => ({
  env: {
    ENABLE_REVIEW_PHASE: false as boolean,
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
    GITHUB_WEBHOOK_SECRET: "secret" as string | undefined,
    GITHUB_OWNER: undefined as string | undefined,
    GITHUB_REPO: undefined as string | undefined,
    MAX_CONCURRENT_AGENTS: 3,
    VCS_BOT_LOGIN: undefined as string | undefined,
  },
}));
vi.mock("../../env.js", () => ({ env: H.env }));

const mockStart = vi.fn();
const mockGetRun = vi.fn();
vi.mock("workflow/api", () => ({
  start: (...args: any[]) => mockStart(...args),
  getRun: (...args: any[]) => mockGetRun(...args),
}));

const mockGetCurrentVersion = vi.fn();
const mockGetEnabled = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getCurrentWorkflowDefinitionVersion: (...args: any[]) => mockGetCurrentVersion(...args),
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
vi.mock("../lib/logger.js", () => ({
  logger: {
    info: (...a: any[]) => loggerInfo(...a),
    warn: (...a: any[]) => loggerWarn(...a),
    error: (...a: any[]) => loggerError(...a),
  },
}));

vi.mock("./agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));

const mockStopTicketSandboxes = vi.fn();
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopTicketSandboxes: (...args: any[]) => mockStopTicketSandboxes(...args),
}));

const mockCancelRun = vi.fn();
vi.mock("../lib/cancel-run.js", () => ({
  cancelRun: (...args: any[]) => mockCancelRun(...args),
}));

vi.mock("../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

// github.post.ts consumes the mocked dispatch-trigger; the dispatchTriggerEvent
// area re-loads the real module via vi.importActual (partial-mock pattern).
const mockDispatchTriggerEvent = vi.fn();
vi.mock("../lib/dispatch-trigger.js", () => ({
  dispatchTriggerEvent: (...args: any[]) => mockDispatchTriggerEvent(...args),
}));

const mockVerifySig = vi.fn();
vi.mock("../lib/github-webhook-sig.js", () => ({
  verifyGitHubWebhookSignature: (...args: any[]) => mockVerifySig(...args),
}));

const mockLoadPostPrGateConfig = vi.fn();
vi.mock("../post-pr-gate/config.js", () => ({
  loadPostPrGateConfig: (...args: any[]) => mockLoadPostPrGateConfig(...args),
}));

const mockDispatchPostPrGateWebhook = vi.fn();
vi.mock("../lib/post-pr-gate-dispatch.js", () => ({
  dispatchPostPrGateWebhook: (...args: any[]) => mockDispatchPostPrGateWebhook(...args),
}));

import {
  loadWorkflowDefinitionFor,
  normalizeDefinitionForExecution,
} from "./definition-step.js";

// ---------------------------------------------------------------------------
// Area 1: normalizeDefinitionForExecution (pure)
// ---------------------------------------------------------------------------
describe("normalizeDefinitionForExecution edge cases", () => {
  function node(
    id: string,
    type: WorkflowDefinitionNode["type"],
    params: WorkflowDefinitionNode["params"] = {},
  ): WorkflowDefinitionNode {
    return { id, type, x: 0, y: 0, params };
  }

  it("appends a second underscore when both __prepare and __prepare_ are taken", () => {
    const nodes = [
      node("t", "trigger_ticket_ai"),
      node("__prepare", "planning_agent"),
      node("__prepare_", "fix_agent"),
      node("x", "implementation_agent"),
    ];
    const edges: WorkflowDefinitionEdge[] = [{ from: "t", to: "x" }];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.nodes[1].id).toBe("__prepare__");
    expect(normalized.nodes[1].type).toBe("prepare_workspace");
    expect(normalized.nodes.map((n) => n.id)).toEqual([
      "t",
      "__prepare__",
      "__prepare",
      "__prepare_",
      "x",
    ]);
    expect(normalized.edges).toEqual([
      { from: "t", to: "__prepare__" },
      { from: "__prepare__", to: "x" },
    ]);
  });

  it("only rewires the FIRST out-edge of a fan-out trigger (2nd successor bypasses prepare)", () => {
    // Documents current behavior: findIndex takes a single out-edge, so t->b
    // stays direct and never runs prepare_workspace on that branch.
    const nodes = [
      node("t", "trigger_ticket_ai"),
      node("a", "planning_agent"),
      node("b", "fix_agent"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "t", to: "a" },
      { from: "t", to: "b" },
    ];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    const prepares = normalized.nodes.filter((n) => n.type === "prepare_workspace");
    expect(prepares).toHaveLength(1);
    expect(normalized.edges).toEqual([
      { from: "t", to: "__prepare" },
      { from: "__prepare", to: "a" },
      { from: "t", to: "b" },
    ]);
  });

  it("short-circuits the whole graph when ANY branch already has a prepare block", () => {
    // Documents current behavior: nodes.some(prepare) returns the graph
    // untouched, so t2's branch runs without a prepare_workspace.
    const nodes = [
      node("t1", "trigger_ticket_ai"),
      node("prep", "prepare_workspace"),
      node("x", "planning_agent"),
      node("t2", "trigger_pr_created", { providers: ["github"], onlyWorkflowOwned: true }),
      node("y", "fix_agent"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "t1", to: "prep" },
      { from: "prep", to: "x" },
      { from: "t2", to: "y" },
    ];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.nodes).toBe(nodes);
    expect(normalized.edges).toBe(edges);
    expect(normalized.nodes.filter((n) => n.type === "prepare_workspace")).toHaveLength(1);
    // t2's successor is still the original, no injected prepare between them.
    expect(normalized.edges).toContainEqual({ from: "t2", to: "y" });
  });

  it("leaves an explicit toPort on the first segment, dropping it from prepare->successor", () => {
    // Mirror of the fromPort test for the trailing segment: the port meant for
    // p now sits on t->__prepare, so p's intended input port is misrouted.
    const nodes = [node("t", "trigger_ticket_ai"), node("p", "planning_agent")];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "t", to: "p", toPort: "in2" } as WorkflowDefinitionEdge,
    ];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.edges).toEqual([
      { from: "t", to: "__prepare", toPort: "in2" },
      { from: "__prepare", to: "p" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Area 2: loadWorkflowDefinitionFor
// ---------------------------------------------------------------------------
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

function enabled(definition: WorkflowDefinition, version = 3, definitionId = 1) {
  return { definition: { id: definitionId }, current: row(definition, version, definitionId) };
}

describe("loadWorkflowDefinitionFor edge cases", () => {
  beforeEach(() => {
    mockGetCurrentVersion.mockReset();
    mockGetEnabled.mockReset();
    loggerError.mockReset();
    loggerInfo.mockReset();
    H.env.ENABLE_REVIEW_PHASE = false;
  });

  it("returns null for a non-ticket trigger when the pinned definition row is missing", async () => {
    mockGetCurrentVersion.mockResolvedValue(null);

    const plan = await loadWorkflowDefinitionFor("trigger_pr_created", 999);

    expect(plan).toBeNull();
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });

  it("returns null and logs an error for a non-ticket trigger whose stored row is invalid", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled({ schemaVersion: 2, nodes: [], edges: [] } as unknown as WorkflowDefinition, 9, 5),
    );

    const plan = await loadWorkflowDefinitionFor("trigger_pr_created");

    expect(plan).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({ version: 9, definitionId: 5 });
  });

  it("treats a matched enabled record with a null current version as no definition", async () => {
    mockGetEnabled.mockResolvedValue({ definition: { id: 1 }, current: null });

    // Ticket trigger falls back to the built-in default...
    const ticketPlan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
    expect(ticketPlan).not.toBeNull();
    expect(ticketPlan!.definitionId).toBeNull();

    // ...but a non-ticket trigger returns null.
    const otherPlan = await loadWorkflowDefinitionFor("planning_agent");
    expect(otherPlan).toBeNull();
  });

  it("injects a virtual prepare_workspace into a valid stored ticket definition without one", async () => {
    const validNoPrepare: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "planning", type: "planning_agent", x: 100, y: 0, params: {} },
      ],
      edges: [{ from: "t", to: "planning" }],
    };
    mockGetEnabled.mockResolvedValue(enabled(validNoPrepare, 8, 4));

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(8);
    expect(plan!.definitionId).toBe(4);
    expect(plan!.nodes.map((n) => n.type)).toEqual([
      "trigger_ticket_ai",
      "prepare_workspace",
      "planning_agent",
    ]);
    expect(loggerError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Area 3: dispatchTriggerEvent (real module via importActual)
// ---------------------------------------------------------------------------
function makeRegistry(
  overrides: Partial<Record<keyof RunRegistryAdapter, ReturnType<typeof vi.fn>>> = {},
): RunRegistryAdapter {
  let claimedValue: string | undefined;
  return {
    claim:
      overrides.claim ??
      vi.fn().mockImplementation(async (_key: string, value: string) => {
        claimedValue = value;
        return true;
      }),
    register: overrides.register ?? vi.fn().mockResolvedValue(undefined),
    unregister: overrides.unregister ?? vi.fn().mockResolvedValue(undefined),
    getRunId: overrides.getRunId ?? vi.fn().mockImplementation(async () => claimedValue),
    listAll: overrides.listAll ?? vi.fn().mockResolvedValue([]),
    registerSandbox: vi.fn().mockResolvedValue(undefined),
    getSandboxId: vi.fn().mockResolvedValue(null),
    getEntryCreatedAt: vi.fn().mockResolvedValue(null),
    markFailed: vi.fn().mockResolvedValue(undefined),
    isTicketFailed: vi.fn().mockResolvedValue(false),
    listAllFailed: vi.fn().mockResolvedValue([]),
    clearFailedMark: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEnabledDefinition(onlyWorkflowOwned?: boolean) {
  return {
    definition: { id: 5, name: "PR flow" },
    current: {
      definition: {
        schemaVersion: 1,
        nodes: [
          {
            id: "t1",
            type: "trigger_pr_created",
            x: 0,
            y: 0,
            params: onlyWorkflowOwned === undefined ? {} : { onlyWorkflowOwned },
          },
        ],
        edges: [],
      },
    },
  };
}

function prEvent(headRef = "blazebot/aiw-1"): TriggerEvent {
  return {
    triggerType: "trigger_pr_created",
    pr: {
      provider: "github",
      repoPath: "acme/app",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      headRef,
      headSha: "abc123",
      baseRef: "main",
      title: "Fix",
      author: "blazebot[bot]",
      isDraft: false,
    },
  };
}

async function loadRealDispatch() {
  const mod = await vi.importActual<typeof import("../lib/dispatch-trigger.js")>(
    "../lib/dispatch-trigger.js",
  );
  return mod.dispatchTriggerEvent;
}

describe("dispatchTriggerEvent edge cases", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockGetRun.mockReset();
    mockGetEnabled.mockReset();
    mockStopTicketSandboxes.mockReset();
    mockStart.mockResolvedValue({ runId: "run_pr" });
    mockStopTicketSandboxes.mockResolvedValue(0);
  });

  it("returns error when the claim throws", async () => {
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition());
    const registry = makeRegistry({
      claim: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const dispatchTriggerEvent = await loadRealDispatch();

    const result = await dispatchTriggerEvent(prEvent(), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "error" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("still ignores a non-bot branch even when onlyWorkflowOwned is false", async () => {
    // onlyWorkflowOwned:false is warn-only; it does not rescue a non-bot branch.
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition(false));
    const registry = makeRegistry();
    const dispatchTriggerEvent = await loadRealDispatch();

    const result = await dispatchTriggerEvent(prEvent("feature/x"), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "ignored_not_workflow_owned" });
    expect(registry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("dispatches even when no node matches the event trigger type (triggerNode undefined)", async () => {
    mockGetEnabled.mockResolvedValue({
      definition: { id: 5, name: "mismatch" },
      current: {
        definition: {
          schemaVersion: 1,
          nodes: [{ id: "t1", type: "trigger_ticket_ai", x: 0, y: 0, params: {} }],
          edges: [],
        },
      },
    });
    const registry = makeRegistry();
    const dispatchTriggerEvent = await loadRealDispatch();

    const result = await dispatchTriggerEvent(prEvent(), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "started", runId: "run_pr" });
    expect(registry.claim).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  it("coalesces and aborts the started run when the claim was overwritten after start", async () => {
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition());
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    mockGetRun.mockReturnValue({ cancel: cancelSpy });
    const registry = makeRegistry({
      getRunId: vi.fn().mockResolvedValue("run_other"),
    });
    const dispatchTriggerEvent = await loadRealDispatch();

    const result = await dispatchTriggerEvent(prEvent(), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "coalesced" });
    expect(mockGetRun).toHaveBeenCalledWith("run_pr");
    expect(cancelSpy).toHaveBeenCalled();
    expect(mockStopTicketSandboxes).toHaveBeenCalledWith("AIW-1");
    expect(registry.register).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Area 4: reconcileRuns
// ---------------------------------------------------------------------------
function makeReconcileRegistry(
  runs: Array<{ ticketKey: string; runId: string; kind?: string }> = [],
  failed: Array<{ ticketKey: string; meta: { runId: string; error: string; failedAt: string } }> = [],
): RunRegistryAdapter {
  return {
    claim: vi.fn(),
    register: vi.fn(),
    getRunId: vi.fn(),
    unregister: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue(runs),
    registerSandbox: vi.fn().mockResolvedValue(undefined),
    getSandboxId: vi.fn().mockResolvedValue(null),
    getEntryCreatedAt: vi.fn().mockResolvedValue(null),
    markFailed: vi.fn().mockResolvedValue(undefined),
    isTicketFailed: vi.fn().mockResolvedValue(false),
    listAllFailed: vi.fn().mockResolvedValue(failed),
    clearFailedMark: vi.fn().mockResolvedValue(undefined),
  };
}

function makeIssueTracker(overrides: Partial<IssueTrackerAdapter> = {}): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn(),
    moveTicket: vi.fn(),
    postComment: vi.fn().mockResolvedValue(null),
    searchTickets: vi.fn(),
    ...overrides,
  };
}

function ticket(identifier: string, trackerStatus: string, projectKey = "PROJ") {
  return {
    id: `id-${identifier}`,
    identifier,
    projectKey,
    title: "x",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
    trackerStatus,
  };
}

describe("reconcileRuns edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStopTicketSandboxes.mockResolvedValue(0);
  });

  it("cancels a still-running finalizing ticket run without ever checking its run status", async () => {
    // GOTCHA: the left-column branch never inspects run status, so a run that
    // finalized its own update_ticket_status (moving the ticket out of AI) is
    // killed exactly like an orphan. Documents current behavior; the desired
    // behavior would be to NOT cancel a run still finalizing its transition.
    const registry = makeReconcileRegistry([
      { ticketKey: "PROJ-901", runId: "run_finalizing", kind: "ticket" },
    ]);
    mockCancelRun.mockResolvedValue(true);
    const issueTracker = makeIssueTracker({
      fetchTicket: vi.fn().mockResolvedValue(ticket("PROJ-901", "Done")),
    });
    // If the code ever consulted run status it would use this; assert it does not.
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    const { reconcileRuns } = await import("../lib/reconcile.js");

    const result = await reconcileRuns(new Set(), registry, issueTracker);

    expect(result).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith("PROJ-901", "run_finalizing", registry);
    expect(mockGetRun).not.toHaveBeenCalled();
  });

  it("skips a fresh non-sentinel orphan inside the grace window", async () => {
    const registry = makeReconcileRegistry([
      { ticketKey: "PROJ-902", runId: "run_fresh", kind: "ticket" },
    ]);
    (registry.getEntryCreatedAt as ReturnType<typeof vi.fn>).mockResolvedValue(Date.now() - 5000);
    const { reconcileRuns } = await import("../lib/reconcile.js");

    const result = await reconcileRuns(new Set(), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("cancels the same orphan once the grace window has lapsed", async () => {
    const registry = makeReconcileRegistry([
      { ticketKey: "PROJ-903", runId: "run_old", kind: "ticket" },
    ]);
    (registry.getEntryCreatedAt as ReturnType<typeof vi.fn>).mockResolvedValue(Date.now() - 60_000);
    mockCancelRun.mockResolvedValue(true);
    const { reconcileRuns } = await import("../lib/reconcile.js");

    const result = await reconcileRuns(new Set(), registry);

    expect(result).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith("PROJ-903", "run_old", registry);
  });

  it("does not clear a failed marker that is still inside the grace window", async () => {
    const registry = makeReconcileRegistry(
      [],
      [
        {
          ticketKey: "PROJ-904",
          meta: { runId: "run_a", error: "move failed", failedAt: new Date().toISOString() },
        },
      ],
    );
    const { reconcileRuns } = await import("../lib/reconcile.js");

    await reconcileRuns(new Set(), registry);

    expect(registry.clearFailedMark).not.toHaveBeenCalled();
  });

  it("cancels an inflight ticket claim that left AI, verified via the issue tracker", async () => {
    const registry = makeReconcileRegistry([
      { ticketKey: "PROJ-905", runId: `claiming:${Date.now()}`, kind: "ticket" },
    ]);
    const issueTracker = makeIssueTracker({
      fetchTicket: vi.fn().mockResolvedValue(ticket("PROJ-905", "Done")),
    });
    const onTicketCancelled = vi.fn().mockResolvedValue(undefined);
    const { reconcileRuns } = await import("../lib/reconcile.js");

    const result = await reconcileRuns(new Set(), registry, issueTracker, onTicketCancelled);

    expect(result).toEqual({ cancelled: 1, cleaned: 0 });
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-905");
    expect(mockStopTicketSandboxes).toHaveBeenCalledWith("PROJ-905", null);
    expect(onTicketCancelled).toHaveBeenCalledWith("PROJ-905", "inflight_claim");
  });

  it("swallows a throwing onTicketCancelled callback and still reports the cancellation", async () => {
    const registry = makeReconcileRegistry([
      { ticketKey: "PROJ-906", runId: "run_orphan", kind: "ticket" },
    ]);
    mockCancelRun.mockResolvedValue(true);
    const onTicketCancelled = vi.fn().mockRejectedValue(new Error("slack down"));
    const { reconcileRuns } = await import("../lib/reconcile.js");

    const result = await reconcileRuns(new Set(), registry, undefined, onTicketCancelled);

    expect(result).toEqual({ cancelled: 1, cleaned: 0 });
    expect(onTicketCancelled).toHaveBeenCalledWith("PROJ-906", "orphaned_run");
  });
});

// ---------------------------------------------------------------------------
// Area 5: POST /webhooks/github route
// ---------------------------------------------------------------------------
async function send(request: Request): Promise<Response> {
  const handler = (await import("../routes/webhooks/github.post.js")).default;
  const app = createApp();
  app.use("/", handler);
  return toWebHandler(app)(request);
}

function makeRequest(body: unknown, ghEvent = "pull_request"): Request {
  return rawRequest(JSON.stringify(body), ghEvent);
}

function rawRequest(rawBody: string, ghEvent = "pull_request"): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=whatever",
      "x-github-event": ghEvent,
    },
    body: rawBody,
  });
}

function repo() {
  return { owner: { login: "acme" }, name: "app", html_url: "https://github.com/acme/app" };
}

function pullRequestBody(action: string, headRef = "blazebot/aiw-1") {
  return {
    action,
    repository: repo(),
    pull_request: {
      number: 7,
      html_url: "https://github.com/acme/app/pull/7",
      head: { ref: headRef, sha: "abc123" },
      base: { ref: "main" },
      title: "Fix",
      body: "desc",
      user: { login: "blazebot[bot]" },
      draft: false,
    },
  };
}

function checkRunBody(name: string, conclusion = "failure") {
  return {
    action: "completed",
    repository: repo(),
    check_run: {
      name,
      conclusion,
      pull_requests: [
        { number: 7, head: { ref: "blazebot/aiw-1", sha: "abc123" }, base: { ref: "main" } },
      ],
    },
  };
}

describe("POST /webhooks/github edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.env.GITHUB_OWNER = undefined;
    H.env.GITHUB_REPO = undefined;
    mockLoadPostPrGateConfig.mockReturnValue({ postPrGate: { steps: [] } });
    mockDispatchPostPrGateWebhook.mockResolvedValue({ status: "dispatched", runId: "gate_run" });
    mockDispatchTriggerEvent.mockResolvedValue({ result: "no_definition" });
  });

  it("returns 401 when the webhook signature is invalid", async () => {
    mockVerifySig.mockImplementationOnce(() => {
      throw new Error("bad signature");
    });

    const response = await send(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(401);
  });

  it("ignores a payload with no repository as malformed", async () => {
    const response = await send(makeRequest({ action: "opened" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "malformed_payload",
    });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
  });

  it("ignores a non-JSON body as malformed", async () => {
    const response = await send(rawRequest("not-json{"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "malformed_payload",
    });
  });

  it("ignores a pull_request event with no pull_request object as malformed", async () => {
    const response = await send(
      makeRequest({ action: "opened", repository: repo() }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "malformed_payload",
    });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
  });

  it("does not self-trigger on the bot's own gate check_run", async () => {
    mockLoadPostPrGateConfig.mockReturnValueOnce({ postPrGate: { steps: [{ name: "lint" }] } });

    const response = await send(makeRequest(checkRunBody("blazebot / lint"), "check_run"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "event_check_run",
    });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
  });

  it("dispatches trigger_pr_created for a reopened action", async () => {
    const response = await send(makeRequest(pullRequestBody("reopened")));

    expect(response.status).toBe(200);
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "trigger_pr_created" }),
      expect.anything(),
    );
  });

  it("dispatches a check_run that a definition handles and skips the gate", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_x" });

    const response = await send(makeRequest(checkRunBody("ci / build"), "check_run"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "dispatched", runId: "run_x" });
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });
});
