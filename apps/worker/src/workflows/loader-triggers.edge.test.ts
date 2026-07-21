import { createApp, toWebHandler } from "h3";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
} from "@shared/contracts";

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
vi.mock("../../env.js", () => ({
  env: H.env,
  getVcsBotLogin: () => H.env.VCS_BOT_LOGIN,
}));

const mockGetCurrentVersion = vi.fn();
const mockGetDeployedVersion = vi.fn();
const mockGetDefinition = vi.fn();
const mockGetVersion = vi.fn();
const mockGetEnabled = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getCurrentWorkflowDefinitionVersion: (...args: any[]) => mockGetCurrentVersion(...args),
  getDeployedWorkflowDefinitionVersion: (...args: any[]) => mockGetDeployedVersion(...args),
  getWorkflowDefinition: (...args: any[]) => mockGetDefinition(...args),
  getWorkflowDefinitionVersion: (...args: any[]) => mockGetVersion(...args),
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

vi.mock("../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

// github.post.ts consumes the mocked dispatch-trigger; the dispatchTriggerEvent
// area re-loads the real module via vi.importActual (partial-mock pattern).
const mockDispatchTriggerEvent = vi.fn();
vi.mock("../lib/dispatch-trigger.js", () => ({
  dispatchTriggerEvent: (...args: any[]) => mockDispatchTriggerEvent(...args),
  resolveEnabledReviewStates: vi.fn().mockResolvedValue(undefined),
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
    return { id, type, x: 0, y: 0, params, inputs: {} };
  }

  it("preserves ids that previously collided with virtual Prepare ids", () => {
    const nodes = [
      node("t", "trigger_ticket_ai"),
      node("__prepare", "planning_agent"),
      node("__prepare_", "fix_agent"),
      node("x", "implementation_agent"),
    ];
    const edges: WorkflowDefinitionEdge[] = [{ from: "t", to: "x" }];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.nodes).toBe(nodes);
    expect(normalized.edges).toBe(edges);
  });

  it("preserves every edge of a fan-out trigger", () => {
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

    expect(normalized.nodes).toBe(nodes);
    expect(normalized.edges).toBe(edges);
  });

  it("preserves mixed explicit-Prepare and implicit-workspace chains", () => {
    const nodes = [
      node("t1", "trigger_ticket_ai"),
      node("prep", "prepare_workspace"),
      node("x", "planning_agent"),
      node("t2", "trigger_pr_created"),
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
  });

  it("preserves an explicit toPort", () => {
    const nodes = [node("t", "trigger_ticket_ai"), node("p", "planning_agent")];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "t", to: "p", toPort: "in2" } as WorkflowDefinitionEdge,
    ];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.edges).toBe(edges);
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
    mockGetDeployedVersion.mockReset();
    mockGetDefinition.mockReset();
    mockGetEnabled.mockReset();
    loggerError.mockReset();
    loggerInfo.mockReset();
    H.env.ENABLE_REVIEW_PHASE = false;
  });

  it("returns null for a non-ticket trigger when the pinned definition row is missing", async () => {
    mockGetDeployedVersion.mockResolvedValue(null);
    mockGetDefinition.mockResolvedValue(null);

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

  it("loads a valid stored ticket definition without injecting Prepare", async () => {
    const validNoPrepare: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
        { id: "planning", type: "planning_agent", x: 100, y: 0, params: {}, inputs: {} },
      ],
      edges: [{ from: "t", to: "planning" }],
    };
    mockGetEnabled.mockResolvedValue(enabled(validNoPrepare, 8, 4));

    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");

    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(8);
    expect(plan!.definitionId).toBe(4);
    expect(plan!.nodes.map((n) => n.type)).toEqual(["trigger_ticket_ai", "planning_agent"]);
    expect(loggerError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Durable trigger dispatch and owner-CAS reconciliation now have dedicated
// focused suites: lib/dispatch-trigger.test.ts and lib/reconcile.test.ts.
// ---------------------------------------------------------------------------
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
      "x-github-delivery": "delivery-edge-test",
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
      id: 101,
      app: { slug: "github-actions" },
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
