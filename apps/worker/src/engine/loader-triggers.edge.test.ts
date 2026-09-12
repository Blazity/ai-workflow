import { createApp, toWebHandler } from "h3";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDefinition } from "@shared/contracts";

// One file, four source areas. vi.mock is hoisted and file-scoped, so we mock
// the union of every dependency once. The runtime environment module is
// shared by all areas; the bot-login helper has its own mock because it resolves
// provider configuration through the config module.
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
vi.mock("../infra/vcs-config.js", () => ({
  env: H.env,
}));
vi.mock("../services/vcs/index.js", () => ({
  getVcsBotLogin: () => H.env.VCS_BOT_LOGIN,
}));

const mockGetCurrentVersion = vi.fn();
const mockGetDeployedVersion = vi.fn();
const mockGetDefinition = vi.fn();
const mockGetVersion = vi.fn();
const mockGetEnabled = vi.fn();
vi.mock("./definition-trigger-routing.js", () => ({
  getConnectedEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));
vi.mock("../db/repositories/definitions.js", () => ({
  getCurrentWorkflowDefinitionVersion: (...args: any[]) => mockGetCurrentVersion(...args),
  getDeployedWorkflowDefinitionVersion: (...args: any[]) => mockGetDeployedVersion(...args),
  getWorkflowDefinition: (...args: any[]) => mockGetDefinition(...args),
  getWorkflowDefinitionVersion: (...args: any[]) => mockGetVersion(...args),
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));
vi.mock("../db/repositories/definitions/connected.js", () => ({
  getConnectedCurrentWorkflowDefinitionVersion: (...args: any[]) =>
    mockGetCurrentVersion(...args),
  getConnectedDeployedWorkflowDefinitionVersion: (...args: any[]) =>
    mockGetDeployedVersion(...args),
  getConnectedWorkflowDefinition: (...args: any[]) => mockGetDefinition(...args),
  getConnectedWorkflowDefinitionVersion: (...args: any[]) => mockGetVersion(...args),
  getConnectedEnabledWorkflowDefinitionForTrigger: (...args: any[]) =>
    mockGetEnabled(...args),
}));

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
vi.mock("../infra/logger.js", () => ({
  logger: {
    info: (...a: any[]) => loggerInfo(...a),
    warn: (...a: any[]) => loggerWarn(...a),
    error: (...a: any[]) => loggerError(...a),
  },
}));

vi.mock("../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../db/repositories/settings.js", () => ({
  // The ingress route loads one settings snapshot per request. This file hands
  // the handler a stub database, and an empty settings table is what a
  // deployment that has stored no decision has, so every value still resolves
  // from the mocked environment exactly as it did before the snapshot existed.
  readAllConnectedSettings: async () => [],
}));
vi.mock("../db/repositories/repository-catalog.js", () => ({
  // Same story as the settings table: the ingress route now also loads one
  // repository catalog snapshot per request, and an empty catalog nobody
  // activated is the bridge, which passes every repository. These cases are
  // about trigger normalization, not about who may be dispatched.
  listConnectedRepositoryCatalogKeys: async () => [],
  getConnectedRepositoryCatalogStateRow: async () => ({
    activated: false,
    activatedAt: null,
    activatedById: null,
    activatedByLabel: null,
  }),
}));

// github.post.ts consumes the mocked dispatch-trigger; the dispatchTriggerEvent
// area re-loads the real module via vi.importActual (partial-mock pattern).
const mockDispatchTriggerEvent = vi.fn();
vi.mock("../services/dispatch/dispatch-trigger.js", () => ({
  dispatchTriggerEvent: (...args: any[]) => mockDispatchTriggerEvent(...args),
  resolveEnabledReviewStates: vi.fn().mockResolvedValue(undefined),
}));

const mockVerifySig = vi.fn();
vi.mock("../infra/github-webhook-sig.js", () => ({
  verifyGitHubWebhookSignature: (...args: any[]) => mockVerifySig(...args),
}));

const mockLoadPostPrGateConfig = vi.fn();
vi.mock("../post-pr-gate/config.js", () => ({
  loadPostPrGateConfig: (...args: any[]) => mockLoadPostPrGateConfig(...args),
}));

const mockDispatchPostPrGateWebhook = vi.fn();
vi.mock("../services/dispatch/post-pr-gate-dispatch.js", () => ({
  dispatchPostPrGateWebhook: (...args: any[]) => mockDispatchPostPrGateWebhook(...args),
}));

import { loadWorkflowDefinitionFor } from "./steps/definition-step.js";
import { testSettingsSnapshot } from "../test-support/settings.js";

/** The settings this run started under; these cases are about the loader, not
 *  about any one key, so they take the registry defaults. */
const settings = testSettingsSnapshot();

// ---------------------------------------------------------------------------
// Area 2: loadWorkflowDefinitionFor
// ---------------------------------------------------------------------------
function row(definition: WorkflowDefinition, version = 3, definitionId = 1) {
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

    const plan = await loadWorkflowDefinitionFor(settings, "trigger_pr_created", 999);

    expect(plan).toBeNull();
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });

  it("returns null and logs an error for a non-ticket trigger whose stored row is invalid", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled({ schemaVersion: 2, nodes: [], edges: [] } as unknown as WorkflowDefinition, 9, 5),
    );

    const plan = await loadWorkflowDefinitionFor(settings, "trigger_pr_created");

    expect(plan).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({ version: 9, definitionId: 5 });
  });

  it("treats a matched enabled record with a null current version as no definition", async () => {
    mockGetEnabled.mockResolvedValue({ definition: { id: 1 }, current: null });

    // Ticket trigger falls back to the built-in default...
    const ticketPlan = await loadWorkflowDefinitionFor(settings, "trigger_ticket_ai");
    expect(ticketPlan).not.toBeNull();
    expect(ticketPlan!.definitionId).toBeNull();

    // ...but a non-ticket trigger returns null.
    const otherPlan = await loadWorkflowDefinitionFor(settings, "planning_agent");
    expect(otherPlan).toBeNull();
  });

  it("loads a valid stored ticket definition without injecting Prepare", async () => {
    const validNoPrepare: WorkflowDefinition = {
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
          id: "planning",
          type: "planning_agent",
          x: 100,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
      ],
      edges: [{ id: "t-planning", from: "t", to: "planning" }],
    };
    mockGetEnabled.mockResolvedValue(enabled(validNoPrepare, 8, 4));

    const plan = await loadWorkflowDefinitionFor(settings, "trigger_ticket_ai");

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

function pullRequestBody(action: string, headRef = "ai-workflow/aiw-1") {
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
        { number: 7, head: { ref: "ai-workflow/aiw-1", sha: "abc123" }, base: { ref: "main" } },
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

  it.each([
    "AI Workflow / lint",
    "blazebot / lint",
  ])("does not self-trigger on the bot's own %s check_run", async (name) => {
    mockLoadPostPrGateConfig.mockReturnValueOnce({ postPrGate: { steps: [{ name: "lint" }] } });

    const response = await send(makeRequest(checkRunBody(name), "check_run"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "event_check_run",
    });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
  });

  it("dispatches trigger_pr_ready for a reopened non-draft PR", async () => {
    const response = await send(makeRequest(pullRequestBody("reopened")));

    expect(response.status).toBe(200);
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "trigger_pr_ready" }),
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
