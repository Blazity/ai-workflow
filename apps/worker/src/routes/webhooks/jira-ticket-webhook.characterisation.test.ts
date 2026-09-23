/**
 * What `POST /webhooks/jira` DOES, pinned across the S12 rewrite.
 *
 * Every payload here is recorded bytes from a real Jira Cloud delivery, kept in
 * `integrations/jira/test-fixtures` with its source URL, its retrieval date and
 * its SHA-256 beside it. Nothing in this file constructs a Jira payload, so no
 * assertion here can be satisfied by a shape only this repository believes in.
 *
 * The subject is the URL, not the module. Before S12 a static route served it;
 * after S12 the one integration webhook route does, and `routeUnderTest` finds
 * whichever module answers. That is deliberate: this file is the contract
 * between Jira and this deployment, and a rewrite that had to edit an assertion
 * here would be a behaviour change nobody declared.
 *
 * What is asserted is what somebody can see: the HTTP status Jira records in
 * its delivery log, the body it records beside it, whether a run was dispatched,
 * resumed or cancelled, whether Slack was told, and whether the delivery was
 * recorded as accepted or rejected on the health screen. The exact wording of a
 * rejection reason belongs to whoever refuses and is tested there.
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createApp, defineEventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WEBHOOK_SECRET = "jira-webhook-secret";

const state = vi.hoisted(() => ({
  env: {
    JIRA_PROJECT_KEY: "ABC",
    JIRA_BASE_URL: "https://zulipp.atlassian.net",
    JIRA_API_TOKEN: "token",
    COLUMN_AI: "AI",
    COLUMN_AI_REVIEW: "Review",
    COLUMN_BACKLOG: "Backlog",
    MAX_CONCURRENT_AGENTS: 3,
    JIRA_WEBHOOK_SECRET: "jira-webhook-secret" as string | undefined,
  },
  /** The board this deployment watches, as both sources of it report it. */
  projectKey: "ABC",
  columns: { COLUMN_AI: "AI", COLUMN_AI_REVIEW: "Review", COLUMN_BACKLOG: "Backlog" },
  createAdapters: vi.fn(),
  dispatch: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  isRunRecordedFailed: vi.fn(),
  isRunRecordedSucceeded: vi.fn(),
  hasDurableRunPublication: vi.fn(),
  classifyProtected: vi.fn(),
  listApprovalParked: vi.fn(),
  /** Every health observation written about this delivery, from either writer. */
  observations: [] as Array<{ integrationId: string; outcome: string; reason: string }>,
  readAllConnectedSettings: vi.fn(),
  deferred: [] as Promise<unknown>[],
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: state.env,
  getConfiguredVcsProviders: () => [],
}));
vi.mock("../../db/repositories/settings.js", () => ({
  readAllConnectedSettings: () => state.readAllConnectedSettings(),
}));
vi.mock("../../engine/support/adapters.js", () => ({ createAdapters: state.createAdapters }));
vi.mock("../../services/dispatch/dispatch.js", () => ({ dispatchTicket: state.dispatch }));
vi.mock("../../services/run-lifecycle/cancel-run.js", () => ({ cancelRunDetailed: state.cancel }));
vi.mock("../../services/clarifications/resume-from-comments.js", () => ({
  resumeConnectedClarificationFromComments: (...args: unknown[]) => state.resume(...args),
}));
vi.mock("../../db/repositories/clarifications.js", () => ({
  classifyConnectedProtectedClarificationSubjects: (...args: unknown[]) =>
    state.classifyProtected(...args),
}));
vi.mock("../../db/repositories/approvals.js", () => ({
  listConnectedApprovalParkedSubjects: (...args: unknown[]) =>
    state.listApprovalParked(...args),
}));
vi.mock("../../db/repositories/runs.js", () => ({
  isConnectedRunRecordedFailed: state.isRunRecordedFailed,
  isConnectedRunRecordedSucceeded: state.isRunRecordedSucceeded,
  hasConnectedDurableRunPublication: state.hasDurableRunPublication,
}));
// Both writers of the delivery observation, so this file sees it whichever one
// records it: the provider-scoped writer core used before S12, and the one the
// shared integration route uses.
vi.mock("../../services/system/provider-webhook-observation.js", () => ({
  observeProviderWebhook: (integrationId: string, outcome: string, reason: string) => {
    state.observations.push({ integrationId, outcome, reason });
  },
}));
vi.mock("../../services/system/observations.js", () => ({
  recordWebhookDelivery: async (observation: {
    integrationId: string;
    outcome: string;
    reason: string;
  }) => {
    state.observations.push({
      integrationId: observation.integrationId,
      outcome: observation.outcome,
      reason: observation.reason,
    });
  },
  systemHealthObservationScope: () => "deployment:test",
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    state.deferred.push(promise);
  },
}));

const { resetAiReviewDestinationCache } = await import(
  "../../services/tickets/ai-review-destination.js"
);

/**
 * The Jira connection the resolver would hand the integration, taken from the
 * same two values the environment mock carries so a test never configures the
 * board twice. Unused until the integration answers this URL.
 */
function connectedJira(): unknown {
  const { integrationRuntime } = registry;
  return {
    // The manifest and the runtime this build ships, not a hand-made pair:
    // the resolver filters on declared capabilities, and a double that
    // declared its own would prove the double.
    manifest: manifests.integrationManifest("jira"),
    runtime: integrationRuntime("jira"),
    ctx: {
      connection: {
        baseUrl: state.env.JIRA_BASE_URL,
        apiToken: state.env.JIRA_API_TOKEN,
        projectKey: state.projectKey,
        webhookSecret: state.env.JIRA_WEBHOOK_SECRET,
      },
      signal: new AbortController().signal,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      // Jira, as far as this deployment can see it. The only thing the
      // integration asks the provider during a delivery is which account it
      // is, and the answer is whatever the test said the tracker would say,
      // so one knob drives it wherever the question is asked from. Before
      // S12 core asked it; after S12 the integration does; the test says the
      // same thing either way.
      http: { fetch: trackerFetch },
    },
  };
}

async function trackerFetch(target: string | URL): Promise<Response> {
  const url = String(target);
  if (url.includes("tenant_info")) {
    return new Response(JSON.stringify({ cloudId: "test-cloud" }), { status: 200 });
  }
  if (url.includes("/myself")) {
    try {
      const tracker = state.createAdapters() as {
        issueTrackerResolution: { adapter: { getCurrentUserAccountId: () => Promise<string> } };
      };
      return new Response(JSON.stringify({ accountId: await tracker.issueTrackerResolution.adapter.getCurrentUserAccountId() }), {
        status: 200,
      });
    } catch {
      return new Response("", { status: 401 });
    }
  }
  throw new Error(`The recorded delivery asked Jira for ${url}, which this test does not answer.`);
}

vi.mock("../../services/integrations/runtime.js", async () => ({
  resolveUsableIntegrations: async (input: {
    filter?: (manifest: { id: string; capabilities: readonly string[] }) => boolean;
  }) => {
    const jira = connectedJira() as { manifest: never };
    const wanted = input.filter?.(jira.manifest) ?? true;
    return {
      readable: true,
      usable: wanted ? [jira] : [],
      states: new Map([["jira", { usable: true, enabled: true, source: "environment" }]]),
    };
  },
  checkIntegrationPin: () => ({ ok: true }),
}));

const registry = await import("@integrations/registry/worker");
const manifests = await import("@integrations/registry");

/**
 * The handler that answers `/webhooks/jira` in this build.
 *
 * A static `jira.post.ts` wins over the dynamic route while it exists, which is
 * exactly how Nitro resolves the two, so this asks the same question Nitro does
 * rather than naming one module and going stale when the other takes over.
 */
async function routeUnderTest() {
  // Which module, decided the way Nitro decides it: a static route file beats
  // the dynamic one. Existence rather than a try around the import, because an
  // import that throws is a broken route and must fail this suite rather than
  // quietly hand it the other one.
  const staticRoute = new URL("./jira.post.ts", import.meta.url);
  if (existsSync(staticRoute)) {
    // Through a variable, because S12 deleted that file and a literal
    // specifier for a module this build does not ship is a compile error. The
    // check stays so that re-adding a static route puts this suite back on it
    // rather than leaving it testing the route Nitro would not reach.
    return ((await import(/* @vite-ignore */ staticRoute.href)) as { default: unknown })
      .default as ReturnType<typeof defineEventHandler>;
  }
  const dynamic = (await import("./[id].post.js")).default;
  return defineEventHandler((event) => {
    event.context.params = { ...event.context.params, id: "jira" };
    return (dynamic as (e: typeof event) => unknown)(event);
  });
}

async function app() {
  const instance = createApp();
  instance.use("/", await routeUnderTest());
  return toWebHandler(instance);
}

function recorded(name: string): string {
  return readFileSync(
    new URL(`../../../../../integrations/jira/test-fixtures/${name}.json`, import.meta.url),
    "utf8",
  );
}

/** A signed delivery of exactly the bytes Jira sent. */
function delivery(name: string, options: { signature?: string } = {}): Request {
  const raw = recorded(name);
  const signature =
    options.signature ??
    `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw, "utf8").digest("hex")}`;
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature": signature },
    body: raw,
  });
}

async function send(name: string, options: { signature?: string } = {}) {
  state.deferred.length = 0;
  const response = await (await app())(delivery(name, options));
  const text = await response.text();
  await Promise.allSettled(state.deferred);
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

/** The board the delivery is judged against, for the fixture under test. */
function board(input: { projectKey: string; ai: string; review?: string; backlog?: string }) {
  state.projectKey = input.projectKey;
  state.env.JIRA_PROJECT_KEY = input.projectKey;
  state.columns = {
    COLUMN_AI: input.ai,
    COLUMN_AI_REVIEW: input.review ?? "Review",
    COLUMN_BACKLOG: input.backlog ?? "Backlog",
  };
  state.readAllConnectedSettings.mockResolvedValue(
    Object.entries({ ...state.columns, MAX_CONCURRENT_AGENTS: 3 }).map(([key, value]) => ({
      key,
      value,
      updatedAt: new Date("2026-09-22T00:00:00.000Z"),
      updatedBy: "test",
    })),
  );
  Object.assign(state.env, state.columns);
}

function adapters(options: {
  state?: "bound" | "cancelling";
  active?: boolean;
  kind?: "ticket" | "manual_pr_trigger";
  ticketKey?: string;
  liveStatus?: string;
  liveStatusId?: string;
  liveProject?: string;
  accountId?: string;
} = {}) {
  const ticketKey = options.ticketKey ?? "TEST-1";
  const active = options.active === false
    ? null
    : {
        subjectKey: `ticket:jira:${ticketKey}`,
        ticketKey,
        ownerToken: "owner-1",
        runId: "run-1",
        state: options.state ?? "bound",
        kind: options.kind ?? "ticket",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
  return {
    issueTrackerResolution: { ok: true, adapter: {
      getCurrentUserAccountId: vi
        .fn()
        .mockResolvedValue(options.accountId ?? "99:the-workflow-account"),
      fetchTicket: vi.fn().mockResolvedValue({
        identifier: ticketKey,
        projectKey: options.liveProject ?? state.projectKey,
        trackerStatus: options.liveStatus ?? "Backlog",
        ...(options.liveStatusId ? { trackerStatusId: options.liveStatusId } : {}),
      }),
      resolveMoveTargetStatus: vi.fn().mockResolvedValue(null),
    } },
    runRegistry: { get: vi.fn().mockResolvedValue(active) },
    messaging: { notifyForTicket: vi.fn().mockResolvedValue(undefined) },
  };
}

/** Whoever really made the change in the status-change fixture. */
const HUMAN_ACCOUNT = "99:b8d8a054-2e12-4839-bd5f-5f2b7c5f5e3a";

describe("POST /webhooks/jira, against recorded Jira deliveries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAiReviewDestinationCache();
    state.observations.length = 0;
    state.env.JIRA_WEBHOOK_SECRET = WEBHOOK_SECRET;
    board({ projectKey: "ABC", ai: "AI" });
    state.cancel.mockResolvedValue({ cancelled: true, released: true });
    state.dispatch.mockResolvedValue({ started: false, reason: "not_applicable" });
    state.resume.mockResolvedValue({ status: "no_clarification" });
    state.isRunRecordedFailed.mockResolvedValue(false);
    state.isRunRecordedSucceeded.mockResolvedValue(false);
    state.hasDurableRunPublication.mockResolvedValue(false);
    state.classifyProtected.mockResolvedValue({ all: [], retained: [], terminal: [] });
    state.listApprovalParked.mockResolvedValue([]);
    state.createAdapters.mockReturnValue(adapters());
  });

  describe("who is allowed to speak", () => {
    it("refuses when no signing secret is configured and records the refusal", async () => {
      state.env.JIRA_WEBHOOK_SECRET = undefined;
      const result = await send("issue-updated-status-change");

      expect(result.status).toBe(503);
      expect(state.observations).toContainEqual(
        expect.objectContaining({ integrationId: "jira", outcome: "rejected" }),
      );
      expect(state.dispatch).not.toHaveBeenCalled();
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("refuses a delivery whose signature does not check out", async () => {
      const result = await send("issue-updated-status-change", {
        signature: "sha256=deadbeef",
      });

      expect(result.status).toBe(401);
      expect(state.observations).toContainEqual(
        expect.objectContaining({ integrationId: "jira", outcome: "rejected" }),
      );
      expect(state.dispatch).not.toHaveBeenCalled();
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("refuses a delivery that carries no signature at all", async () => {
      const raw = recorded("issue-updated-status-change");
      const response = await (await app())(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        }),
      );

      expect(response.status).toBe(401);
      expect(state.dispatch).not.toHaveBeenCalled();
    });

    it("costs nothing but the signature check when the signature is wrong", async () => {
      // The ingress is public. A forged delivery must not reach the settings
      // table, so a flood stays cheap and a database outage still answers 401.
      await send("issue-updated-status-change", { signature: "sha256=deadbeef" });

      expect(state.readAllConnectedSettings).not.toHaveBeenCalled();
      expect(state.createAdapters).not.toHaveBeenCalled();
    });
  });

  describe("deliveries this deployment has nothing to do with", () => {
    it("ignores a delivery that names no ticket", async () => {
      const result = await send("payload-without-issue");

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ status: "ignored", reason: "no_ticket_key" });
      expect(state.dispatch).not.toHaveBeenCalled();
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("ignores a ticket in a project nobody configured", async () => {
      board({ projectKey: "OTHER", ai: "AI" });

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({
        status: "ignored",
        reason: "wrong_project",
        ticketKey: "TEST-1",
      });
      expect(state.dispatch).not.toHaveBeenCalled();
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("records an accepted delivery it decided to ignore", async () => {
      board({ projectKey: "OTHER", ai: "AI" });

      await send("issue-updated-status-change");

      expect(state.observations).toContainEqual(
        expect.objectContaining({ integrationId: "jira", outcome: "accepted" }),
      );
    });

    it("ignores a status the deployment's own tracker account moved", async () => {
      state.createAdapters.mockReturnValue(adapters({ accountId: HUMAN_ACCOUNT }));

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ status: "ignored", reason: "workflow_actor" });
      expect(state.dispatch).not.toHaveBeenCalled();
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("treats a tracker that cannot say who acted as somebody else acting", async () => {
      const connected = adapters();
      connected.issueTrackerResolution.adapter.getCurrentUserAccountId.mockRejectedValue(
        new Error("Jira unavailable"),
      );
      state.createAdapters.mockReturnValue(connected);

      await send("issue-updated-status-change");

      expect(state.cancel).toHaveBeenCalledOnce();
    });

    it("ignores an update outside the AI column that changed no status", async () => {
      board({ projectKey: "TEST", ai: "AI" });
      state.createAdapters.mockReturnValue(adapters({ accountId: "99:someone-else" }));

      const result = await send("issue-updated-no-status-change");

      expect(result.body).toMatchObject({ status: "ignored", reason: "no_status_change" });
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("ignores a comment on a ticket outside the AI column", async () => {
      board({ projectKey: "SP", ai: "AI" });

      const result = await send("comment-created");

      expect(result.body).toMatchObject({ status: "ignored", reason: "no_status_change" });
      expect(state.cancel).not.toHaveBeenCalled();
    });
  });

  describe("a ticket that is in the AI column", () => {
    it("dispatches a run for a ticket the delivery says is in the AI column", async () => {
      board({ projectKey: "ABC", ai: "In Progress" });
      state.dispatch.mockResolvedValue({ started: true, reason: "dispatched", runId: "run-7" });

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ status: "dispatched", ticketKey: "TEST-1" });
      expect(state.dispatch).toHaveBeenCalledOnce();
    });

    it("reports a dispatch that did not start, with the reason it did not", async () => {
      board({ projectKey: "ABC", ai: "In Progress" });
      state.dispatch.mockResolvedValue({ started: false, reason: "at_capacity" });

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ status: "skipped", reason: "at_capacity" });
    });

    it("dispatches a newly created ticket that arrives in the AI column", async () => {
      board({ projectKey: "BUG", ai: "Open" });
      state.createAdapters.mockReturnValue(adapters({ ticketKey: "BUG-15" }));
      state.dispatch.mockResolvedValue({ started: true, reason: "dispatched" });

      const result = await send("issue-created");

      expect(result.body).toMatchObject({ status: "dispatched", ticketKey: "BUG-15" });
      expect(state.dispatch).toHaveBeenCalledOnce();
    });

    it("reads the settings once the signature checks out", async () => {
      board({ projectKey: "ABC", ai: "In Progress" });

      await send("issue-updated-status-change");

      expect(state.readAllConnectedSettings).toHaveBeenCalled();
    });

    it("resumes a suspended clarification instead of dispatching", async () => {
      board({ projectKey: "ABC", ai: "In Progress" });
      state.resume.mockResolvedValue({ status: "resumed", runId: "run-9" });

      const result = await send("issue-updated-status-change");

      expect(result.body).toEqual({
        status: "resumed",
        reason: "clarification_resumed",
        ticketKey: "TEST-1",
      });
      expect(state.dispatch).not.toHaveBeenCalled();
    });

    it("lets the move into the AI column nudge for an answer", async () => {
      board({ projectKey: "ABC", ai: "In Progress" });

      await send("issue-updated-status-change");

      expect(state.resume).toHaveBeenCalledWith(
        expect.objectContaining({ ticketKey: "TEST-1", allowNudge: true }),
      );
    });

    it("does not nudge on a delivery that changed no status", async () => {
      board({ projectKey: "TEST", ai: "To Do" });

      await send("issue-updated-no-status-change");

      expect(state.resume).toHaveBeenCalledWith(
        expect.objectContaining({ ticketKey: "TEST-1", allowNudge: false }),
      );
    });

    it("skips dispatch when the resume helper fails unexpectedly", async () => {
      board({ projectKey: "ABC", ai: "In Progress" });
      state.resume.mockRejectedValue(new Error("db down"));

      const result = await send("issue-updated-status-change");

      expect(result.body).toEqual({
        status: "skipped",
        reason: "clarification_resume_error",
        ticketKey: "TEST-1",
      });
      expect(state.dispatch).not.toHaveBeenCalled();
    });

    it("continues an owner that is already closing rather than dispatching", async () => {
      board({ projectKey: "ABC", ai: "In Progress" });
      state.createAdapters.mockReturnValue(adapters({ state: "cancelling" }));

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({
        reason: "human_status_change_during_cancellation",
      });
      expect(state.dispatch).not.toHaveBeenCalled();
    });

    it("reports the real outcome when a closing run went terminal on its own", async () => {
      board({ projectKey: "ABC", ai: "In Progress" });
      const connected = adapters({ state: "cancelling" });
      state.createAdapters.mockReturnValue(connected);
      state.cancel.mockResolvedValue({ cancelled: true, released: true, alreadyTerminal: true });

      const result = await send("issue-updated-status-change");

      expect(result.body).toEqual({
        status: "ignored",
        reason: "already_terminal",
        ticketKey: "TEST-1",
      });
      expect(connected.messaging.notifyForTicket).not.toHaveBeenCalled();
    });
  });

  describe("a ticket a person pulled out of the AI column", () => {
    it("cancels the exact owner and says which columns it moved between", async () => {
      const connected = adapters();
      state.createAdapters.mockReturnValue(connected);

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ status: "cancelled", reason: "left_ai_column" });
      expect(state.cancel).toHaveBeenCalledWith({
        ticketKey: "TEST-1",
        target: { ownerToken: "owner-1", runId: "run-1" },
        runRegistry: connected.runRegistry,
        issueTracker: connected.issueTrackerResolution.adapter,
        reason: "Ticket left the AI column (AI → In Progress) via Jira webhook",
        clarificationNotice: { aiColumnName: "AI" },
      });
    });

    it("tells the ticket's channel that the run was cancelled", async () => {
      const connected = adapters();
      state.createAdapters.mockReturnValue(connected);

      await send("issue-updated-status-change");

      expect(connected.messaging.notifyForTicket).toHaveBeenCalledWith("TEST-1", {
        kind: "canceled",
        reason: "webhook confirmed ticket is outside AI column",
      });
    });

    it("does not cancel when the live ticket is back in the AI column", async () => {
      state.createAdapters.mockReturnValue(adapters({ liveStatus: "AI" }));
      state.dispatch.mockResolvedValue({ started: true, reason: "dispatched" });

      const result = await send("issue-updated-status-change");

      expect(state.cancel).not.toHaveBeenCalled();
      expect(result.body).toMatchObject({ status: "dispatched" });
    });

    it("leaves a manual pull request dispatch alone", async () => {
      state.createAdapters.mockReturnValue(adapters({ kind: "manual_pr_trigger" }));

      const result = await send("issue-updated-status-change");

      expect(result.body).toEqual({
        status: "ignored",
        reason: "manual_pr_dispatch_independent",
        ticketKey: "TEST-1",
      });
      expect(state.isRunRecordedFailed).not.toHaveBeenCalled();
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("does not cancel a run whose failure is already recorded", async () => {
      state.isRunRecordedFailed.mockResolvedValue(true);

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ status: "ignored", reason: "run_already_failed" });
      expect(state.isRunRecordedFailed).toHaveBeenCalledWith("run-1");
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("does not cancel a run whose success is already recorded", async () => {
      state.isRunRecordedSucceeded.mockResolvedValue(true);

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ status: "ignored", reason: "run_already_succeeded" });
      expect(state.isRunRecordedSucceeded).toHaveBeenCalledWith("run-1");
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("asks again rather than guessing when the failure lookup fails", async () => {
      state.isRunRecordedFailed.mockRejectedValue(new Error("db down"));

      const result = await send("issue-updated-status-change");

      expect(result.status).toBe(503);
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("records a delivery it could not finish handling as rejected", async () => {
      // The health screen reads the LAST word on a delivery. A delivery whose
      // signature checked out but whose handling failed is not a delivery this
      // deployment dealt with, and recording it as accepted would paint the
      // webhook Live while every one of them was failing.
      state.isRunRecordedFailed.mockRejectedValue(new Error("db down"));

      await send("issue-updated-status-change");

      expect(state.observations.at(-1)).toMatchObject({
        integrationId: "jira",
        outcome: "rejected",
      });
    });

    it("asks again rather than guessing when the success lookup fails", async () => {
      state.isRunRecordedSucceeded.mockRejectedValue(new Error("db down"));

      const result = await send("issue-updated-status-change");

      expect(result.status).toBe(503);
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("keeps a run parked on a question alive when its own backlog move fires", async () => {
      state.classifyProtected.mockResolvedValue({
        all: ["ticket:jira:TEST-1"],
        retained: ["ticket:jira:TEST-1"],
        terminal: [],
      });

      const result = await send("issue-updated-status-change");

      expect(result.body).toEqual({
        status: "ignored",
        reason: "run_parked_for_clarification",
        ticketKey: "TEST-1",
      });
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("still cancels a parked run when a person moved it somewhere else", async () => {
      state.createAdapters.mockReturnValue(adapters({ liveStatus: "Done" }));
      state.classifyProtected.mockResolvedValue({
        all: ["ticket:jira:TEST-1"],
        retained: ["ticket:jira:TEST-1"],
        terminal: [],
      });

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ status: "cancelled", reason: "left_ai_column" });
      expect(state.cancel).toHaveBeenCalledOnce();
    });

    it("keeps a run parked on a plan approval alive when its own backlog move fires", async () => {
      state.listApprovalParked.mockResolvedValue(["ticket:jira:TEST-1"]);

      const result = await send("issue-updated-status-change");

      expect(result.body).toEqual({
        status: "ignored",
        reason: "run_parked_for_approval",
        ticketKey: "TEST-1",
      });
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("still cancels an approval-parked ticket a person moved somewhere else", async () => {
      state.createAdapters.mockReturnValue(adapters({ liveStatus: "Done" }));
      state.listApprovalParked.mockResolvedValue(["ticket:jira:TEST-1"]);

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ status: "cancelled", reason: "left_ai_column" });
      expect(state.cancel).toHaveBeenCalledOnce();
    });

    it("reports the real outcome when the run went terminal as the ticket left", async () => {
      const connected = adapters();
      state.createAdapters.mockReturnValue(connected);
      state.cancel.mockResolvedValue({ cancelled: true, released: true, alreadyTerminal: true });

      const result = await send("issue-updated-status-change");

      expect(result.body).toEqual({
        status: "ignored",
        reason: "already_terminal",
        ticketKey: "TEST-1",
      });
      expect(connected.messaging.notifyForTicket).not.toHaveBeenCalled();
    });

    it("asks again when the cancellation is not confirmed", async () => {
      state.cancel.mockResolvedValue({ cancelled: false, released: false });

      const result = await send("issue-updated-status-change");

      expect(result.status).toBe(503);
    });
  });

  describe("a ticket that reached the AI Review column", () => {
    it("does not cancel a still finalising run whose work is already published", async () => {
      board({ projectKey: "ABC", ai: "AI", review: "In Progress" });
      state.createAdapters.mockReturnValue(adapters({ liveStatus: "In Progress" }));
      state.hasDurableRunPublication.mockResolvedValue(true);

      const result = await send("issue-updated-status-change");

      expect(result.body).toEqual({
        status: "ignored",
        reason: "ticket_in_ai_review_column",
        ticketKey: "TEST-1",
      });
      expect(state.cancel).not.toHaveBeenCalled();
      expect(state.hasDurableRunPublication).toHaveBeenCalledWith("run-1");
    });

    it("cancels a move to AI Review made before any work was published", async () => {
      board({ projectKey: "ABC", ai: "AI", review: "In Progress" });
      state.createAdapters.mockReturnValue(adapters({ liveStatus: "In Progress" }));

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ status: "cancelled", reason: "left_ai_column" });
      expect(state.cancel).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "Jira AI Review transition before durable PR publication evidence",
        }),
      );
    });

    it("ignores an AI Review move on a ticket with no run behind it", async () => {
      board({ projectKey: "ABC", ai: "AI", review: "In Progress" });
      state.createAdapters.mockReturnValue(
        adapters({ active: false, liveStatus: "In Progress" }),
      );

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({
        status: "ignored",
        reason: "ticket_in_ai_review_column",
      });
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("asks again rather than guessing when the publication lookup fails", async () => {
      board({ projectKey: "ABC", ai: "AI", review: "In Progress" });
      state.createAdapters.mockReturnValue(adapters({ liveStatus: "In Progress" }));
      state.hasDurableRunPublication.mockRejectedValue(new Error("db down"));

      const result = await send("issue-updated-status-change");

      expect(result.status).toBe(503);
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("recognises the review destination by status id when the names differ", async () => {
      // The configured review target names a TRANSITION, and the status it
      // lands in carries a localized display name. Comparing display names
      // misses on every such Jira and reads the run's own success move as a
      // person pulling the ticket out.
      board({ projectKey: "ABC", ai: "AI", review: "Weryfikacja" });
      const connected = adapters({ liveStatus: "Weryfikacja", liveStatusId: "3" });
      connected.issueTrackerResolution.adapter.resolveMoveTargetStatus.mockResolvedValue({
        id: "3",
        name: "Weryfikacja",
      });
      state.hasDurableRunPublication.mockResolvedValue(true);
      state.createAdapters.mockReturnValue(connected);

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ reason: "ticket_in_ai_review_column" });
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it("still cancels a genuine pull-out when the resolved destination differs", async () => {
      board({ projectKey: "ABC", ai: "AI", review: "Weryfikacja" });
      const connected = adapters({ liveStatus: "Gotowe", liveStatusId: "10002" });
      connected.issueTrackerResolution.adapter.resolveMoveTargetStatus.mockResolvedValue({
        id: "11418",
        name: "Weryfikacja",
      });
      state.createAdapters.mockReturnValue(connected);

      const result = await send("issue-updated-status-change");

      expect(result.body).toMatchObject({ status: "cancelled", reason: "left_ai_column" });
      expect(state.cancel).toHaveBeenCalledOnce();
    });
  });
});
