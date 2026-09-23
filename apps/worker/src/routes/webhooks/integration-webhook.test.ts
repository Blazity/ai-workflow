/**
 * The one webhook route every integration answers at, through the real Slack
 * package.
 *
 * What is tested here is the part core owns: the bytes reach the integration
 * unparsed, the provider gets its acknowledgement inside its own deadline, the
 * command runs afterwards, and its outcome comes back even when it failed. The
 * signature algorithm and the wording belong to the package and are tested
 * there (`integrations/slack/slash-command.test.ts`).
 *
 * `/webhooks/slack` is the address Slack already calls, and it still answers
 * here: the static route was deleted, so this dynamic one takes it.
 *
 * The resolver is a double here, handing out whatever each case set. Which
 * values a webhook is served on is proved through the real one:
 * `slack-signing-secret-only.test.ts` beside this file, and
 * `services/integrations/webhook-resolution.test.ts`.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

const state = vi.hoisted(() => ({
  usable: [] as unknown[],
  readable: true,
  states: new Map<string, unknown>(),
  execute: undefined as unknown,
  observations: [] as Array<{ integrationId: string; outcome: string; reason: string }>,
  dispatch: vi.fn(),
  legacyGate: vi.fn(),
  boundPipeline: null as unknown,
  workflowPush: {} as {
    workflowPublishedHeadSha?: string;
    workflowOwnedPullRequest?: boolean;
  },
  suppressPush: false,
  pushSuppressionInputs: [] as Record<string, unknown>[],
  botLogin: vi.fn(async (_provider: string) => "ai-workflow-bot" as string | undefined),
  botLoginReadable: true,
}));

vi.mock("../../services/integrations/runtime.js", () => ({
  resolveUsableIntegrations: async () =>
    state.readable
      ? { readable: true, usable: state.usable, states: state.states }
      : { readable: false, reason: "the settings read timed out" },
}));

const executeRunControlCommand = vi.fn();
vi.mock("../../services/run-control/index.js", () => ({
  executeRunControlCommand,
  runControlDeps: async () => ({}),
}));

vi.mock("../../services/settings/index.js", () => ({
  getRequestSettingsSnapshot: async () => ({ MAX_CONCURRENT_AGENTS: 3 }),
  maxConcurrentAgents: () => 3,
}));
vi.mock("../../services/repository-catalog/index.js", () => ({
  getRequestRepositoryCatalogSnapshot: async () => ({ activated: false }),
}));
vi.mock("../../db/repositories/active-runs.js", () => ({
  createConnectedPostgresRunRegistry: () => ({}),
}));
vi.mock("../../services/dispatch/index.js", () => ({
  createConnectedTriggerRunRegistry: () => ({}),
  dispatchTriggerEvent: state.dispatch,
  dispatchPostPrGateWebhook: state.legacyGate,
  isRepositoryDispatchable: () => true,
  recordIngestionFailure: () => "AIW-DIAG-ingest-test",
}));
vi.mock("../../engine/support/vcs-runtime.js", () => ({
  createRepositoryVCS: vi.fn(),
}));
// A stand-in, not a copy. What the predicate decides is proved against the real
// function in `services/publication/workflow-push-suppression.test.ts`; a double
// that reimplements it here would only prove the double. What the route owes it
// is the delivery's own head, producer and ownership record, and then obedience
// to the answer, so this one records what it was asked and returns what the test
// set.
vi.mock("../../services/publication/index.js", () => ({
  connectedWorkflowPushNormalizationOptions: vi.fn(async () => state.workflowPush),
  isWorkflowGeneratedPush: vi.fn((input: Record<string, unknown>) => {
    state.pushSuppressionInputs.push(input);
    return state.suppressPush;
  }),
}));
vi.mock("../../services/vcs/index.js", () => ({
  // The route reads the automation account through the half that says whether
  // the settings could be read at all, because acting on a delivery without
  // knowing that account is how the workflow answers itself.
  readVcsBotLogin: async (provider: string) =>
    state.botLoginReadable
      ? { readable: true, login: await state.botLogin(provider) }
      : { readable: false, reason: "the settings read timed out" },
}));
vi.mock("../../infra/vcs-config.js", () => ({
  env: {},
  getConfiguredVcsProviders: vi.fn(() => []),
}));

const deferred: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    deferred.push(promise);
  },
}));

vi.mock("../../services/system/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../services/system/observations.js", () => ({
  recordWebhookDelivery: async (observation: {
    integrationId: string;
    outcome: string;
    reason: string;
  }) => {
    state.observations.push(observation);
  },
}));

const handler = (await import("./[id].post.js")).default;
const { logger } = await import("../../services/system/logger.js");
const { integrationRuntime } = await import("@integrations/registry/worker");
// The real Slack runtime out of the registry, which is exactly what the route
// reaches for: a hand-written double here would prove the double works.
const runtime = integrationRuntime("slack")!;

/**
 * The Slack context the resolver would have built for its webhook: exactly
 * the field the webhook requires, and the operator settings it declares.
 */
function connectedSlack(): unknown {
  return {
    manifest: { id: "slack", name: "Slack" },
    runtime,
    ctx: {
      connection: { signingSecret: SIGNING_SECRET },
      settings: { allowedUserIds: [] },
      signal: new AbortController().signal,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      http: { fetch: globalThis.fetch },
    },
  };
}

function connectedGitLab(): unknown {
  return {
    manifest: { id: "gitlab", name: "GitLab" },
    runtime: integrationRuntime("gitlab")!,
    ctx: {
      connection: {
        token: "glpat-test",
        host: "https://gitlab.example.com",
        webhookSecret: "webhook-secret",
      },
      signal: new AbortController().signal,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      http: { fetch: globalThis.fetch },
    },
  };
}

function connectedGitHub(): unknown {
  return {
    manifest: { id: "github", name: "GitHub" },
    runtime: integrationRuntime("github")!,
    ctx: {
      connection: {
        appId: 1,
        installationId: 2,
        privateKey: "key",
        webhookSecret: "webhook-secret",
      },
      signal: new AbortController().signal,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      http: { fetch: globalThis.fetch },
    },
  };
}

/**
 * A real GitHub push to an open pull request: the published `synchronize`
 * delivery, byte for byte, signed the way GitHub signs one.
 */
function githubSyncRequest(sender?: string, author?: string): Request {
  const payload = JSON.parse(
    readFileSync(
      new URL(
        "../../../../../integrations/github/test-fixtures/pull-request-synchronize.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (sender) payload.sender.login = sender;
  // The pull request's author, which on one this product opened is our own
  // account whoever pushes to it.
  if (author) payload.pull_request.user.login = author;
  const body = JSON.stringify(payload);
  return new Request("http://localhost/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "4c5f2a80-9b1e-11ee-8c90-0242ac120002",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "webhook-secret")
        .update(body, "utf8")
        .digest("hex")}`,
    },
    body,
  });
}

/** A failed check run: an event with no legacy gate behind it, so what comes
 *  back says what the trigger did and nothing else. */
function githubCheckRunRequest(): Request {
  const body = readFileSync(
    new URL(
      "../../../../../integrations/github/test-fixtures/check-run-completed-failure.json",
      import.meta.url,
    ),
    "utf8",
  );
  return new Request("http://localhost/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "check_run",
      "x-github-delivery": "5d6e3b91-ac2f-11ee-8c90-0242ac120002",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "webhook-secret")
        .update(body, "utf8")
        .digest("hex")}`,
    },
    body,
  });
}

function request(id: string, text: string): Request {
  const body = new URLSearchParams({
    user_id: "U2147483697",
    command: "/ai-workflow",
    text,
    response_url: "https://hooks.slack.com/commands/T0001/1/abc",
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(`http://localhost/webhooks/${id}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", SIGNING_SECRET)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`,
    },
    body,
  });
}

function gitlabRequest(): Request {
  return new Request("http://localhost/webhooks/gitlab", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": "webhook-secret",
      "x-gitlab-event": "Merge Request Hook",
      "webhook-id": "delivery-17",
    },
    body: JSON.stringify({
      object_kind: "merge_request",
      user: { username: "alice" },
      project: {
        path_with_namespace: "platform/api",
        web_url: "https://gitlab.example.com/platform/api",
      },
      object_attributes: {
        action: "open",
        iid: 17,
        title: "Ready",
        source_branch: "feature/ready",
        target_branch: "main",
        url: "https://gitlab.example.com/platform/api/-/merge_requests/17",
        draft: false,
        last_commit: { id: "head-sha" },
      },
    }),
  });
}

function gitlabPipelineRequest(
  source = "merge_request_event",
): Request {
  return new Request("http://localhost/webhooks/gitlab", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": "webhook-secret",
      "x-gitlab-event": "Pipeline Hook",
      "webhook-id": "pipeline-31",
    },
    body: JSON.stringify({
      object_kind: "pipeline",
      project: {
        id: 1,
        path_with_namespace: "gitlab-org/gitlab-test",
        web_url: "https://gitlab.example.com/gitlab-org/gitlab-test",
      },
      object_attributes: {
        id: 31,
        status: "failed",
        source,
        sha: "bcbb5ec396a2c0f828686f14fac9b80b780504f2",
      },
      merge_request: {
        iid: 1,
        source_branch: "test",
        target_branch: "master",
        title: "Test",
        url: "https://gitlab.example.com/gitlab-org/gitlab-test/-/merge_requests/1",
      },
      builds: [{ id: 378, name: "test-build", status: "failed" }],
    }),
  });
}

function gitlabUpdateRequest(): Request {
  return new Request("http://localhost/webhooks/gitlab", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": "webhook-secret",
      "x-gitlab-event": "Merge Request Hook",
      "webhook-id": "update-17",
    },
    body: JSON.stringify({
      object_kind: "merge_request",
      oldrev: "previous-sha",
      // Deliberately not the configured bot. The integration must emit this
      // event so the route-level published-head guard is the code under test.
      user: { username: "alice" },
      project: {
        path_with_namespace: "platform/api",
        web_url: "https://gitlab.example.com/platform/api",
      },
      object_attributes: {
        action: "update",
        iid: 17,
        title: "Ready",
        source_branch: "feature/ready",
        target_branch: "main",
        url: "https://gitlab.example.com/platform/api/-/merge_requests/17",
        draft: false,
        last_commit: { id: "published-sha" },
      },
    }),
  });
}

/**
 * A merge request edit that moved nothing: same head before and after, only the
 * title changed. The integration emits no trigger for it, which is the one
 * shape that reaches the route's legacy gate without a candidate event to
 * suppress first.
 */
function gitlabTitleEditRequest(): Request {
  return new Request("http://localhost/webhooks/gitlab", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": "webhook-secret",
      "x-gitlab-event": "Merge Request Hook",
      "webhook-id": "title-edit-17",
    },
    body: JSON.stringify({
      object_kind: "merge_request",
      oldrev: "published-sha",
      user: { username: "alice" },
      project: {
        path_with_namespace: "platform/api",
        web_url: "https://gitlab.example.com/platform/api",
      },
      object_attributes: {
        action: "update",
        iid: 17,
        title: "Ready, renamed",
        source_branch: "feature/ready",
        target_branch: "main",
        url: "https://gitlab.example.com/platform/api/-/merge_requests/17",
        draft: false,
        last_commit: { id: "published-sha" },
      },
    }),
  });
}

function app() {
  // A router, not `use`: the route reads `event.context.params.id`, which is
  // what the file name `[id].post.ts` gives it in the worker.
  const router = createRouter().post("/webhooks/:id", handler);
  return toWebHandler(createApp().use(router));
}

let posted: { url: string; body: unknown }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  posted = [];
  state.usable = [connectedSlack()];
  state.readable = true;
  state.states = new Map([["slack", { enabled: true }]]);
  state.observations = [];
  state.dispatch.mockReset().mockResolvedValue({ result: "started" });
  state.legacyGate.mockReset().mockResolvedValue({ status: "dispatched", runId: "gate-run" });
  state.boundPipeline = null;
  state.workflowPush = {};
  state.suppressPush = false;
  state.pushSuppressionInputs = [];
  state.botLogin.mockReset().mockResolvedValue("ai-workflow-bot");
  state.botLoginReadable = true;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
});

describe("POST /webhooks/:id", () => {
  it("answers inside the provider's deadline and delivers the result afterwards", async () => {
    // Slack gives about three seconds. The work here never finishes until this
    // test lets it, so a route that waited for it would hang.
    let finish: (answer: unknown) => void = () => {};
    executeRunControlCommand.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const response = await app()(request("slack", "list"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response_type: "ephemeral",
      text: "Working on `/ai-workflow list`...",
    });
    expect(posted).toHaveLength(0);

    finish({ kind: "runs", runs: [] });
    await Promise.all(deferred);

    expect(executeRunControlCommand).toHaveBeenCalledWith({ kind: "list" }, {});
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("https://hooks.slack.com/commands/T0001/1/abc");
  });

  // The runtime the resolver hands out is the one behind the redaction
  // boundary (`redactingRuntime`), so what an integration's webhook throws
  // reaches this route with the connection's secrets already out of it. The
  // registry's copy of the same runtime has no such boundary.
  it("calls the webhook of the runtime the resolver handed out", async () => {
    const receive = vi.fn(async () => ({
      kind: "answered" as const,
      response: { status: 200, body: { through: "resolved runtime" } },
    }));
    const slack = connectedSlack() as { runtime: object };
    state.usable = [{ ...slack, runtime: { ...slack.runtime, webhook: { receive } } }];

    const response = await app()(request("slack", "list"));

    expect(receive).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ through: "resolved runtime" });
  });

  it("delivers a failure instead of leaving the person reading \"Working on ...\"", async () => {
    executeRunControlCommand.mockRejectedValue(new Error("the database refused"));

    const response = await app()(request("slack", "list"));
    await Promise.all(deferred);

    expect(response.status).toBe(200);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({ response_type: "ephemeral" });
    expect((posted[0]!.body as { text: string }).text).toMatch(
      /^:warning: `\/ai-workflow list` could not be completed/u,
    );
  });

  it("posts no SQL and no parameters when a command fails on a database error, only a reference to the log", async () => {
    // drizzle-orm 0.45 spells a failed query as its SQL, then its parameters
    // (DrizzleQueryError); this is what reached a channel that may be shared
    // with another company. The error goes to the log, under the reference
    // the person is given.
    executeRunControlCommand.mockRejectedValue(
      new Error(
        "Failed query: select \"run_id\" from \"active_runs\" where \"ticket_key\" = $1\nparams: AWT-42",
      ),
    );

    await app()(request("slack", "cancel AWT-42"));
    await Promise.all(deferred);

    const text = (posted[0]!.body as { text: string }).text;
    expect(text).not.toMatch(/Failed query|select|active_runs|params/u);
    const logged = vi.mocked(logger.error).mock.calls.find(
      ([, event]) => event === "run_control_command_failed",
    )?.[0] as { diagnosticId: string; error: string } | undefined;
    expect(logged?.error).toContain("Failed query");
    expect(logged?.diagnosticId).toMatch(/^AIW-DIAG-run-control-/u);
    expect(text).toContain(`\`${logged!.diagnosticId}\``);
  });

  it("answers help itself without deferring run-control work", async () => {
    const response = await app()(request("slack", "help"));
    await Promise.all(deferred);

    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(1);
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });

  it("refuses a request the integration did not recognise as genuine", async () => {
    const tampered = new Request("http://localhost/webhooks/slack", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=deadbeef",
      },
      body: "text=list",
    });

    expect((await app()(tampered)).status).toBe(401);
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });

  it("accepts and records a disabled integration's webhook without running it", async () => {
    // An admin switched it off. Any non-2xx response makes the provider retry
    // and can eventually make it disable the webhook itself.
    state.usable = [];
    state.states = new Map([["slack", { enabled: false }]]);

    const response = await app()(request("slack", "list"));
    await Promise.all(deferred);

    expect(response.status).toBe(202);
    expect(state.observations).toEqual([
      expect.objectContaining({
        integrationId: "slack",
        outcome: "accepted",
        reason: "integration_disabled_ignored",
      }),
    ]);
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });

  it("does not act on a request it cannot check, and says why", async () => {
    // Settings unreadable: this deployment cannot tell an allowed sender from
    // anybody else, so it fails closed and loudly rather than silently.
    state.readable = false;

    const response = await app()(request("slack", "cancel AWT-42"));
    await Promise.all(deferred);

    expect(response.status).toBe(503);
    expect(state.observations).toEqual([
      expect.objectContaining({
        integrationId: "slack",
        outcome: "rejected",
        reason: "integration_configuration_unreadable",
      }),
    ]);
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });

  it("refuses a disconnected integration because it has no connection that can verify the sender", async () => {
    state.usable = [];
    state.states = new Map([["slack", { enabled: true, connection: "not_connected" }]]);

    const response = await app()(request("slack", "list"));
    await Promise.all(deferred);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("not connected");
    expect(state.observations).toEqual([
      expect.objectContaining({
        integrationId: "slack",
        outcome: "rejected",
        reason: "integration_disconnected",
      }),
    ]);
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });

  it("names what the webhook is missing when the rest of the connection works", async () => {
    // Slack posts run notifications fine and was never given its signing
    // secret: "not connected" would send the admin to a connection that works.
    state.usable = [];
    state.states = new Map([["slack", { enabled: true, connection: "connected" }]]);

    const response = await app()(request("slack", "list"));

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("webhook needs its Signing secret");
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });

  it("404s an id no integration in this build claims", async () => {
    expect((await app()(request("nosuchprovider", "list"))).status).toBe(404);
  });

  it("keeps the GitLab webhook URL and dispatches its normalized events", async () => {
    state.usable = [connectedGitLab()];
    state.states = new Map([["gitlab", { enabled: true }]]);

    const response = await app()(gitlabRequest());
    await Promise.all(deferred);

    expect(response.status).toBe(202);
    expect(state.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "trigger_pr_ready",
        pr: expect.objectContaining({ provider: "gitlab", repoPath: "platform/api" }),
      }),
      expect.any(Object),
    );
  });

  it("dispatches a failed GitLab pipeline only when its head and provider handle still match", async () => {
    state.usable = [connectedGitLab()];
    state.states = new Map([["gitlab", { enabled: true }]]);
    const { bindCurrentPullRequest } = await import(
      "../../engine/support/trigger-current-pull-request.js"
    );
    const { GitLabAdapter } = await import(
      "../../../../../integrations/gitlab/vcs.js"
    );
    const { gitlabHandleIdentity } = await import(
      "../../../../../integrations/gitlab/pipeline-checks.js"
    );
    const adapter = new GitLabAdapter(
      {
        token: "glpat-test",
        host: "https://gitlab.example.com",
        projectId: "gitlab-org/gitlab-test",
        baseBranch: "master",
      },
      {
        MergeRequests: {
          show: vi.fn(async () => ({
            diff_refs: { head_sha: "bcbb5ec396a2c0f828686f14fac9b80b780504f2" },
            source_branch: "test",
            target_branch: "master",
            state: "opened",
            head_pipeline: { id: 31, status: "failed" },
          })),
        },
        Jobs: {
          all: vi.fn(async () => [{ id: 378, name: "test-build", status: "failed" }]),
        },
      } as never,
    );
    const current = await adapter.getPRHead(1);
    state.dispatch.mockImplementation(async (candidate) => {
      state.boundPipeline = bindCurrentPullRequest(candidate, current, gitlabHandleIdentity);
      return state.boundPipeline ? { result: "started" } : { result: "ignored_stale_head" };
    });

    const response = await app()(gitlabPipelineRequest());
    await Promise.all(deferred);

    expect(response.status).toBe(202);
    expect(state.boundPipeline).toMatchObject({
      triggerType: "trigger_pr_checks_failed",
      pr: {
        headSha: "bcbb5ec396a2c0f828686f14fac9b80b780504f2",
        failedChecks: [{
          name: "test-build",
          conclusion: "failed",
        }],
      },
    });
    const boundHandle = (state.boundPipeline as {
      pr?: { failedChecks?: Array<{ handle?: import("@integrations/sdk").VcsOpaqueHandle }> };
    })?.pr?.failedChecks?.[0]?.handle;
    const currentHandle = current.checks?.failed.find(
      (check) => check.name === "test-build",
    )?.handle;
    expect(gitlabHandleIdentity.sameHandle(boundHandle, currentHandle)).toBe(true);
  });

  it.each([
    ["merge_request_event", true],
    ["push", false],
    ["schedule", false],
  ] as const)(
    "keeps GitLab pipeline source %s on the legacy empty allow-list trust boundary",
    async (source, expectedEligible) => {
      state.usable = [connectedGitLab()];
      state.states = new Map([["gitlab", { enabled: true }]]);
      const { selectEligibleEvent } = await import(
        "../../services/dispatch/dispatch-trigger.js"
      );
      let eligible = false;
      state.dispatch.mockImplementation(async (candidate) => {
        eligible = selectEligibleEvent(candidate, { trustedProducers: [] }) !== null;
        return eligible ? { result: "started" } : { result: "ignored_untrusted_event" };
      });

      const response = await app()(gitlabPipelineRequest(source));
      await Promise.all(deferred);

      expect(response.status).toBe(202);
      expect(eligible).toBe(expectedEligible);
    },
  );

  it("does not let the workflow's own GitLab push supersede the run that published it", async () => {
    state.usable = [connectedGitLab()];
    state.states = new Map([["gitlab", { enabled: true }]]);
    state.workflowPush = {
      workflowPublishedHeadSha: "published-sha",
      workflowOwnedPullRequest: true,
    };
    state.suppressPush = true;

    const response = await app()(gitlabUpdateRequest());
    await Promise.all(deferred);

    expect(response.status).toBe(202);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.legacyGate).not.toHaveBeenCalled();
  });

  it("asks about the push with the delivery's own head, producer and ownership", async () => {
    // Everything the predicate can answer with comes from here. A route that
    // passed its own idea of the head, or forgot the ownership record, would
    // get a correct answer to the wrong question and this test would not see
    // it through the dispatch count alone.
    state.usable = [connectedGitLab()];
    state.states = new Map([["gitlab", { enabled: true }]]);
    state.workflowPush = {
      workflowPublishedHeadSha: "published-sha",
      workflowOwnedPullRequest: true,
    };

    await app()(gitlabUpdateRequest());
    await Promise.all(deferred);

    expect(state.pushSuppressionInputs[0]).toEqual({
      currentHeadSha: "published-sha",
      producer: "alice",
      botIdentity: "ai-workflow-bot",
      workflowPublishedHeadSha: "published-sha",
      workflowOwnedPullRequest: true,
    });
  });

  it("makes a chat delivery pay nothing for a version control lookup", async () => {
    // `readVcsBotLogin` reads this deployment's integration settings again. Slack
    // has no automation account in that sense and gets `undefined` however the
    // read turns out, so the read is pure latency against a deadline of about
    // three seconds.
    executeRunControlCommand.mockResolvedValue({ kind: "status", runs: [] });

    await app()(request("slack", "/ai-workflow status"));
    await Promise.all(deferred);

    expect(state.botLogin).not.toHaveBeenCalled();
  });

  it("resolves the automation account once for a whole delivery", async () => {
    // One GitLab delivery asks for it in the webhook context, again for each
    // candidate event, and again for the legacy gate: the same answer, bought
    // three times inside the provider's deadline.
    state.usable = [connectedGitLab()];
    state.states = new Map([["gitlab", { enabled: true }]]);
    state.workflowPush = { workflowOwnedPullRequest: true };

    await app()(gitlabUpdateRequest());
    await Promise.all(deferred);

    expect(state.botLogin.mock.calls.map(([provider]) => provider)).toEqual(["gitlab"]);
  });

  it("hands dispatch the automation-account reading it already holds", async () => {
    // A review needs the account inside dispatch as well. Reading it there on
    // its own was one more settings read for the same answer in the same
    // delivery, once per candidate event.
    state.usable = [connectedGitLab()];
    state.states = new Map([["gitlab", { enabled: true }]]);
    state.workflowPush = { workflowOwnedPullRequest: true };
    state.dispatch.mockImplementation(
      async (
        candidate: { pr: { provider: string } },
        deps: { readBotLogin: (provider: string) => Promise<unknown> },
      ) => {
        await deps.readBotLogin(candidate.pr.provider);
        return { result: "no_definition" };
      },
    );

    const response = await app()(gitlabUpdateRequest());
    await Promise.all(deferred);

    expect(response.status).toBeLessThan(300);
    expect(state.dispatch).toHaveBeenCalled();
    expect(state.botLogin.mock.calls.map(([provider]) => provider)).toEqual(["gitlab"]);
  });

  it("dispatches the push the predicate calls foreign", async () => {
    state.usable = [connectedGitLab()];
    state.states = new Map([["gitlab", { enabled: true }]]);
    state.workflowPush = {
      workflowPublishedHeadSha: "an-older-head",
      workflowOwnedPullRequest: true,
    };

    const response = await app()(gitlabUpdateRequest());
    await Promise.all(deferred);

    expect(response.status).toBe(202);
    expect(state.dispatch).toHaveBeenCalled();
  });

  /**
   * The GitHub half of the same question, and the reason it is here rather
   * than in the integration's own suite: until S11 the GitHub normalizer
   * decided this itself, from an ownership record it should never have had.
   * Moving that decision to the route is what made the two providers answer it
   * the same way, so these four cases are the ones the move has to keep.
   */
  describe("a push to a GitHub pull request", () => {
    beforeEach(() => {
      state.usable = [connectedGitHub()];
      state.states = new Map([["github", { enabled: true }]]);
    });

    it("does not let the workflow's own push supersede the run that published it", async () => {
      state.workflowPush = {
        workflowPublishedHeadSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        workflowOwnedPullRequest: true,
      };
      state.suppressPush = true;

      const response = await app()(githubSyncRequest());
      await Promise.all(deferred);

      expect(response.status).toBe(202);
      expect(state.dispatch).not.toHaveBeenCalled();
      // And the legacy gate does not run on it either, which is the half a
      // comparison on GitLab's word for a push used to leave unchecked here.
      expect(state.legacyGate).not.toHaveBeenCalled();
    });

    it("asks about the push with the delivery's own head, producer and ownership", async () => {
      state.workflowPush = {
        workflowPublishedHeadSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        workflowOwnedPullRequest: true,
      };

      await app()(githubSyncRequest("ai-workflow[bot]"));
      await Promise.all(deferred);

      expect(state.pushSuppressionInputs[0]).toEqual({
        currentHeadSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        producer: "ai-workflow[bot]",
        botIdentity: "ai-workflow-bot",
        workflowPublishedHeadSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        workflowOwnedPullRequest: true,
      });
    });

    it("dispatches a push the predicate calls foreign", async () => {
      state.workflowPush = {
        workflowPublishedHeadSha: "an-older-head",
        workflowOwnedPullRequest: true,
      };

      const response = await app()(githubSyncRequest());
      await Promise.all(deferred);

      expect(response.status).toBe(202);
      expect(state.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ triggerType: "trigger_pr_updated" }),
        expect.anything(),
      );
    });

    it("asks the gate about a human push to a pull request our own account opened", async () => {
      // THE INVERSE OF THE SUPPRESSION DEFECT. Every pull request this product
      // opens is authored by the automation account, so deciding "was this push
      // ours" from the pull request's author answers yes to every human push
      // and the post-PR gate never runs on the one kind of change it exists to
      // check. The question is who pushed, and the delivery says so.
      state.workflowPush = {
        workflowPublishedHeadSha: "a-head-this-run-published",
        workflowOwnedPullRequest: true,
      };

      await app()(githubSyncRequest("filip", "ai-workflow-bot"));
      await Promise.all(deferred);

      expect(state.pushSuppressionInputs.at(-1)).toMatchObject({
        producer: "filip",
        botIdentity: "ai-workflow-bot",
      });
      expect(state.pushSuppressionInputs.at(-1)).not.toMatchObject({
        producer: "ai-workflow-bot",
      });
    });

    it("tells the provider's delivery log what core did with the delivery", async () => {
      // The integration answers before dispatch, so its own body can only say
      // whether there was anything to dispatch. An event for a repository
      // nobody enabled logged at GitHub as "accepted" leaves an operator with
      // nowhere to see that no run started.
      state.dispatch.mockResolvedValue({ result: "ignored_repository_not_enabled" });

      const ignored = await app()(githubCheckRunRequest());
      await Promise.all(deferred);

      expect(ignored.status).toBe(202);
      expect(await ignored.json()).toEqual({
        status: "ignored",
        reason: "ignored_repository_not_enabled",
      });

      state.dispatch.mockResolvedValue({ result: "started", runId: "run-77" });

      const started = await app()(githubCheckRunRequest());
      await Promise.all(deferred);

      expect(await started.json()).toEqual({ status: "dispatched", runId: "run-77" });
    });

    it("refuses the delivery when the automation account could not be read", async () => {
      // The first settings read fails closed one screen up; this is a second
      // read and it can fail on its own. Acting on the delivery without the
      // account means every comment and push we made reads as somebody else's,
      // so the workflow answers its own review and starts a run off its own
      // push.
      state.botLoginReadable = false;

      const response = await app()(githubSyncRequest());
      await Promise.all(deferred);

      expect(response.status).toBe(503);
      expect(state.dispatch).not.toHaveBeenCalled();
      expect(state.legacyGate).not.toHaveBeenCalled();
      // The same verdict as dispatch's own unreadable account: a retry this
      // deployment owes, with a diagnostic, not a handler that crashed.
      expect(await response.json()).toMatchObject({
        statusMessage: "bot_login_unreadable",
        data: { diagnosticId: "AIW-DIAG-ingest-test" },
      });
      expect(state.observations.at(-1)).toEqual({
        integrationId: "github",
        outcome: "rejected",
        reason: "bot_login_unreadable",
      });
    });

    // GitLab switches a webhook off after four failed deliveries in a row, and
    // for good after forty: a token that expired overnight would leave the
    // group hook off after it was rotated. So a refused credential answers
    // 2xx, and the health row, which reads the observation, goes red instead.
    it("answers a refused provider credential 2xx and records it as rejected", async () => {
      state.dispatch.mockResolvedValue({
        result: "vcs_credential_refused",
        diagnosticId: "AIW-DIAG-ingest-refused",
      });

      const response = await app()(githubSyncRequest());
      await Promise.all(deferred);

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        status: "ignored",
        reason: "vcs_credential_refused",
        diagnosticId: "AIW-DIAG-ingest-refused",
      });
      expect(state.observations.at(-1)).toEqual({
        integrationId: "github",
        outcome: "rejected",
        reason: "vcs_credential_refused",
      });
      expect(state.legacyGate).not.toHaveBeenCalled();
    });

    it("tells a delivery that will still run from one that never will", async () => {
      // Queued behind the pull request's current run, the delivery starts when
      // that run ends. Dropped by the start budget or the fix-attempt cap,
      // nothing follows. The provider's log is where an operator tells the two
      // apart, so they must not read the same.
      state.dispatch.mockResolvedValue({ result: "coalesced" });
      const queued = await app()(githubSyncRequest());
      await Promise.all(deferred);
      expect(queued.status).toBe(202);
      expect(await queued.json()).toEqual({ status: "queued" });

      for (const reason of ["rate_limited", "autofix_cap_reached"]) {
        state.dispatch.mockResolvedValue({ result: reason });
        const dropped = await app()(githubSyncRequest());
        await Promise.all(deferred);
        expect(dropped.status).toBe(202);
        expect(await dropped.json()).toEqual({ status: "ignored", reason });
      }
      expect(state.legacyGate).not.toHaveBeenCalled();
    });

    it("says the deployment was at capacity without failing the delivery", async () => {
      // Nothing is wrong with what the provider sent, and GitLab switches a
      // webhook off after a few consecutive failures: a 5xx here would trade
      // this one missed event for every later one. The delivery log carries
      // the reason instead, which is what an operator reads either way.
      state.dispatch.mockResolvedValue({ result: "at_capacity" });

      const response = await app()(githubSyncRequest());
      await Promise.all(deferred);

      expect(response.status).toBe(202);
      // The definition owns the delivery even though no run started for it
      // yet, so the post-PR gate does not start beside it.
      expect(await response.json()).toEqual({ status: "ignored", reason: "at_capacity" });
      expect(state.legacyGate).not.toHaveBeenCalled();
    });

    it("still answers 5xx when the dispatch itself failed", async () => {
      // A fault of this deployment, not a busy one: red in the provider's log,
      // and redeliverable by hand.
      state.dispatch.mockResolvedValue({ result: "error", diagnosticId: "diag-9" });

      const response = await app()(githubSyncRequest());
      await Promise.all(deferred);

      expect(response.status).toBe(503);
    });
  });

  it("asks about a delivery that moved a head even when it produced no trigger", async () => {
    // The one path where the legacy gate is reached without a candidate event
    // to suppress first. The route knows to ask because the integration said
    // the head moved; reading a provider's own word for it instead would leave
    // every other provider's push unasked about.
    state.usable = [connectedGitLab()];
    state.states = new Map([["gitlab", { enabled: true }]]);
    state.workflowPush = {
      workflowPublishedHeadSha: "published-sha",
      workflowOwnedPullRequest: true,
    };
    state.suppressPush = true;

    const response = await app()(gitlabTitleEditRequest());
    await Promise.all(deferred);

    expect(response.status).toBe(202);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.pushSuppressionInputs).toHaveLength(1);
    expect(state.legacyGate).not.toHaveBeenCalled();
  });
});

/**
 * What a provider's delivery log and this deployment's health screen say about
 * a delivery of pull request events. Both are written from the outcome, once
 * it is known: a delivery this deployment failed to act on must never read as
 * accepted, and one it acted on must say what it did, not merely that the
 * integration found something to dispatch.
 */
describe("the verdict on a pull request delivery", () => {
  beforeEach(() => {
    state.usable = [connectedGitLab()];
    state.states = new Map([["gitlab", { enabled: true }]]);
  });

  async function deliver(request: Request) {
    const response = await app()(request);
    await Promise.all(deferred);
    return response;
  }

  it("reports the run a later candidate started after an earlier one found no definition", async () => {
    // An opened merge request is both ready and created, in that order.
    state.dispatch
      .mockResolvedValueOnce({ result: "no_definition" })
      .mockResolvedValueOnce({ result: "started", runId: "run-created" });

    const response = await deliver(gitlabRequest());

    expect(await response.json()).toEqual({ status: "dispatched", runId: "run-created" });
    expect(state.legacyGate).not.toHaveBeenCalled();
    expect(state.observations).toEqual([
      { integrationId: "gitlab", outcome: "accepted", reason: "request_accepted" },
    ]);
  });

  it("reports the gate's run when no definition wanted the merge request", async () => {
    state.dispatch.mockResolvedValue({ result: "no_definition" });

    const response = await deliver(gitlabRequest());

    expect(state.legacyGate).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({
      status: "dispatched",
      reason: "post_pr_gate",
      runId: "gate-run",
    });
  });

  it("reports the gate's own refusal instead of claiming it dispatched", async () => {
    state.dispatch.mockResolvedValue({ result: "no_definition" });
    state.legacyGate.mockResolvedValue({ status: "ignored", reason: "lock_busy" });

    const response = await deliver(gitlabRequest());

    expect(await response.json()).toEqual({ status: "ignored", reason: "lock_busy" });
  });

  it("reports a claimed delivery that started nothing as ignored, with the reason", async () => {
    state.dispatch.mockResolvedValue({ result: "ignored_untrusted_event" });

    const response = await deliver(gitlabPipelineRequest());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "ignored", reason: "ignored_untrusted_event" });
  });

  it("does not start the legacy gate on a delivery a definition claimed at capacity", async () => {
    // The definition owns the event and its envelope waits for capacity; a
    // gate run beside it would review the same merge request twice.
    state.dispatch.mockResolvedValue({ result: "at_capacity" });

    const response = await deliver(gitlabRequest());

    expect(await response.json()).toEqual({ status: "ignored", reason: "at_capacity" });
    expect(state.legacyGate).not.toHaveBeenCalled();
  });

  it("records a retryable dispatch failure as rejected, never accepted", async () => {
    state.dispatch.mockResolvedValue({ result: "error", diagnosticId: "diag-1" });

    const response = await deliver(gitlabRequest());

    expect(response.status).toBe(503);
    expect(state.observations).toEqual([
      { integrationId: "gitlab", outcome: "rejected", reason: "trigger_error" },
    ]);
  });

  it("records a dispatch that threw as rejected, never accepted", async () => {
    state.dispatch.mockRejectedValue(new Error("database went away"));

    const response = await deliver(gitlabRequest());

    expect(response.status).toBe(500);
    expect(state.observations).toEqual([
      { integrationId: "gitlab", outcome: "rejected", reason: "handler_failed" },
    ]);
  });

  it("records an integration that threw while receiving as rejected", async () => {
    const webhook = integrationRuntime("gitlab")!.webhook!;
    const receive = vi.spyOn(webhook, "receive").mockRejectedValueOnce(new Error("parser bug"));

    const response = await deliver(gitlabRequest());
    receive.mockRestore();

    expect(response.status).toBe(500);
    expect(state.observations).toEqual([
      { integrationId: "gitlab", outcome: "rejected", reason: "handler_failed" },
    ]);
  });

  it("refuses a wrong token without reading the automation account", async () => {
    // The endpoint is public: a forged delivery costs the one connection read
    // it needs to find the secret, and nothing more.
    const forged = new Request("http://localhost/webhooks/gitlab", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-token": "wrong",
        "x-gitlab-event": "Note Hook",
      },
      body: "{}",
    });

    const response = await deliver(forged);

    expect(response.status).toBe(401);
    expect(state.botLogin).not.toHaveBeenCalled();
  });
});
