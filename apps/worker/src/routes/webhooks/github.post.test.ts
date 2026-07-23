import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    GITHUB_WEBHOOK_SECRET: "secret",
    GITHUB_OWNER: undefined as string | undefined,
    GITHUB_REPO: undefined as string | undefined,
    MAX_CONCURRENT_AGENTS: 3,
    VCS_BOT_LOGIN: undefined as string | undefined,
    GITHUB_BOT_LOGIN: undefined as string | undefined,
  },
  getVcsBotLogin: vi.fn(),
  isRepoAllowed: vi.fn(),
}));

vi.mock("../../../env.js", () => ({
  env: mocks.env,
  getVcsBotLogin: mocks.getVcsBotLogin,
}));

const mockVerifySignature = vi.fn();
vi.mock("../../lib/github-webhook-sig.js", () => ({
  verifyGitHubWebhookSignature: (...args: any[]) => mockVerifySignature(...args),
}));

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
vi.mock("../../lib/logger.js", () => ({
  logger: {
    info: (...a: any[]) => loggerInfo(...a),
    warn: (...a: any[]) => loggerWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("../../lib/repo-allowlist.js", () => ({
  isRepoAllowed: (...args: any[]) => mocks.isRepoAllowed(...args),
}));

vi.mock("../../post-pr-gate/config.js", () => ({
  loadPostPrGateConfig: () => ({ postPrGate: { steps: [] } }),
}));

vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));

const mockDispatchTriggerEvent = vi.fn();
vi.mock("../../lib/dispatch-trigger.js", () => ({
  dispatchTriggerEvent: (...args: any[]) => mockDispatchTriggerEvent(...args),
}));

const mockDispatchPostPrGateWebhook = vi.fn();
vi.mock("../../lib/post-pr-gate-dispatch.js", () => ({
  dispatchPostPrGateWebhook: (...args: any[]) => mockDispatchPostPrGateWebhook(...args),
}));

const gitHubHandler = (await import("./github.post.js")).default;

function makeApp() {
  const app = createApp();
  app.use("/", gitHubHandler);
  return toWebHandler(app);
}

function makeRequest(body: unknown, ghEvent = "pull_request"): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=whatever",
      "x-github-event": ghEvent,
      "x-github-delivery": "delivery-test",
    },
    body: JSON.stringify(body),
  });
}

function repo() {
  return { owner: { login: "acme" }, name: "app", html_url: "https://github.com/acme/app" };
}

function pullRequestBody(action: string, headRef = "blazebot/aiw-1"): any {
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

describe("POST /webhooks/github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.GITHUB_OWNER = undefined;
    mocks.env.GITHUB_REPO = undefined;
    mocks.env.VCS_BOT_LOGIN = undefined;
    mocks.env.GITHUB_BOT_LOGIN = undefined;
    mocks.getVcsBotLogin.mockReturnValue("github-app[bot]");
    mocks.isRepoAllowed.mockReturnValue(true);
    mockDispatchPostPrGateWebhook.mockResolvedValue({ status: "dispatched", runId: "gate_run" });
    mockDispatchTriggerEvent.mockResolvedValue({ result: "no_definition" });
  });

  function reviewBody(state: string, headRef = "blazebot/aiw-1", reviewer = "human") {
    return {
      action: "submitted",
      repository: repo(),
      pull_request: {
        number: 7,
        html_url: "https://github.com/acme/app/pull/7",
        head: { ref: headRef, sha: "abc123" },
        base: { ref: "main" },
        title: "Fix",
        body: "desc",
        user: { login: "human" },
        draft: false,
      },
      review: { state, user: { login: reviewer }, body: "please fix" },
    };
  }

  it("rejects an off-allowlist repository before definition dispatch or gate work", async () => {
    mocks.isRepoAllowed.mockReturnValueOnce(false);

    const response = await makeApp()(makeRequest(pullRequestBody("opened", "external-branch")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "other_repo",
      diagnosticId: "delivery-test",
    });
    expect(mocks.isRepoAllowed).toHaveBeenCalledWith("acme/app");
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("passes a commented review to the dispatcher for snapshot-bound selector evaluation", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "ignored_untrusted_event" });

    const response = await makeApp()(
      makeRequest(reviewBody("commented"), "pull_request_review"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "ignored_untrusted_event",
      diagnosticId: "delivery-test",
    });
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "trigger_pr_review",
        pr: expect.objectContaining({
          review: expect.objectContaining({ state: "commented" }),
        }),
      }),
      expect.anything(),
    );
  });

  it("dispatches a commented review when the definition opts into commented", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_rv" });

    const response = await makeApp()(
      makeRequest(reviewBody("commented"), "pull_request_review"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "dispatched", runId: "run_rv" });
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "trigger_pr_review" }),
      expect.anything(),
    );
  });

  it("filters reviews using the GitHub-specific bot login", async () => {
    mocks.env.VCS_BOT_LOGIN = "legacy-bot";
    mocks.env.GITHUB_BOT_LOGIN = "github-app[bot]";
    mocks.getVcsBotLogin.mockReturnValueOnce("github-app[bot]");

    const response = await makeApp()(
      makeRequest(
        reviewBody("changes_requested", "blazebot/aiw-1", "github-app[bot]"),
        "pull_request_review",
      ),
    );

    expect(response.status).toBe(200);
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
  });

  it("falls back to the legacy VCS bot login for GitHub reviews", async () => {
    mocks.env.VCS_BOT_LOGIN = "legacy-bot";
    mocks.getVcsBotLogin.mockReturnValueOnce("legacy-bot");

    const response = await makeApp()(
      makeRequest(
        reviewBody("changes_requested", "blazebot/aiw-1", "legacy-bot"),
        "pull_request_review",
      ),
    );

    expect(response.status).toBe(200);
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
  });

  it("delegates a missing-bot review decision to the snapshot-bound dispatcher", async () => {
    mocks.getVcsBotLogin.mockReturnValueOnce(undefined);
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "ignored_untrusted_event" });

    const response = await makeApp()(
      makeRequest(reviewBody("commented"), "pull_request_review"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "ignored_untrusted_event",
      diagnosticId: "delivery-test",
    });
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "trigger_pr_review" }),
      expect.anything(),
    );
  });

  it("starts a definition run and supersedes the gate for a bot PR", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_pr" });

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "dispatched", runId: "run_pr" });
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "trigger_pr_created" }),
      expect.anything(),
    );
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("falls through to the gate when no definition handles the trigger", async () => {
    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "dispatched", runId: "gate_run" });
    expect(mockDispatchTriggerEvent).toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).toHaveBeenCalledWith({
      action: "opened",
      workflowInput: {
        prNumber: 7,
        headSha: "abc123",
        headRef: "blazebot/aiw-1",
        baseRef: "main",
        title: "Fix",
        body: "desc",
        author: "blazebot[bot]",
        isDraft: false,
        url: "https://github.com/acme/app/pull/7",
        ownerRepo: "acme/app",
        provider: "github",
      },
    });
  });

  it("routes synchronize straight to the gate without trigger dispatch", async () => {
    const response = await makeApp()(makeRequest(pullRequestBody("synchronize")));

    expect(response.status).toBe(200);
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).toHaveBeenCalled();
  });

  it("keeps the gate for a non-bot PR that an enabled definition ignores", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "ignored_not_workflow_owned" });

    const response = await makeApp()(makeRequest(pullRequestBody("opened", "feature/x")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "dispatched", runId: "gate_run" });
    expect(mockDispatchTriggerEvent).toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "opened",
        workflowInput: expect.objectContaining({ headRef: "feature/x" }),
      }),
    );
  });

  it("does not gate a failed check_run when no definition handles it", async () => {
    const checkRunBody = {
      action: "completed",
      repository: repo(),
      check_run: {
        id: 1001,
        name: "ci / build",
        conclusion: "failure",
        app: { slug: "github-actions" },
        pull_requests: [
          { number: 7, head: { ref: "blazebot/aiw-1", sha: "abc123" }, base: { ref: "main" } },
        ],
      },
    };

    const response = await makeApp()(makeRequest(checkRunBody, "check_run"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "no_definition", diagnosticId: "delivery-test" });
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "trigger_pr_checks_failed" }),
      expect.anything(),
    );
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("dispatches a merged pull request through the merged trigger", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_merge" });
    const body = pullRequestBody("closed");
    body.pull_request.merged = true;
    body.pull_request.merge_commit_sha = "merge-sha";
    body.pull_request.merged_at = "2026-07-17T10:00:00Z";

    const response = await makeApp()(makeRequest(body));

    expect(response.status).toBe(200);
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "trigger_pr_merged",
        pr: expect.objectContaining({ mergeSha: "merge-sha" }),
      }),
      expect.anything(),
    );
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("does not invoke the legacy gate when no definition handles a merged pull request", async () => {
    const body = pullRequestBody("closed");
    body.pull_request.merged = true;

    const response = await makeApp()(makeRequest(body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "no_definition", diagnosticId: "delivery-test" });
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when dispatch is at capacity", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "at_capacity" });

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(503);
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when dispatch errors", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "error" });

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(503);
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("returns 200 without gating when a live run coalesces the delivery", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "coalesced" });

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "coalesced", diagnosticId: "delivery-test" });
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("ignores unsupported pull_request actions", async () => {
    const response = await makeApp()(makeRequest(pullRequestBody("closed")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "action_closed", diagnosticId: "delivery-test" });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("skips events from other repositories", async () => {
    mocks.env.GITHUB_OWNER = "other";
    mocks.env.GITHUB_REPO = "repo";

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "other_repo", diagnosticId: "delivery-test" });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("dispatches a pull_request_review_comment through the trigger path", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_rc" });
    const body = {
      action: "created",
      repository: repo(),
      pull_request: {
        number: 7,
        html_url: "https://github.com/acme/app/pull/7",
        head: { ref: "blazebot/aiw-1", sha: "abc123" },
        base: { ref: "main" },
        title: "Fix",
        user: { login: "human" },
        draft: false,
      },
      comment: {
        id: 5,
        pull_request_review_id: 9,
        user: { login: "human", type: "User" },
        body: "please fix",
      },
    };

    const response = await makeApp()(makeRequest(body, "pull_request_review_comment"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "dispatched", runId: "run_rc" });
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "trigger_pr_review",
        pr: expect.objectContaining({
          review: expect.objectContaining({ state: "commented" }),
        }),
      }),
      expect.anything(),
    );
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("dispatches an issue_comment on a PR through the trigger path", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_ic" });
    const body = {
      action: "created",
      repository: repo(),
      issue: {
        number: 7,
        title: "Fix",
        user: { login: "author-person" },
        pull_request: { html_url: "https://github.com/acme/app/pull/7" },
      },
      comment: { id: 77, user: { login: "human", type: "User" }, body: "conversation feedback" },
    };

    const response = await makeApp()(makeRequest(body, "issue_comment"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "dispatched", runId: "run_ic" });
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "trigger_pr_review",
        pr: expect.objectContaining({
          prNumber: 7,
          review: expect.objectContaining({ state: "commented" }),
        }),
      }),
      expect.anything(),
    );
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("ignores an unrelated event without dispatching or gating", async () => {
    const response = await makeApp()(makeRequest({ repository: repo() }, "workflow_run"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "event_workflow_run",
      diagnosticId: "delivery-test",
    });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("matches the configured repo case-insensitively", async () => {
    // GitHub org/repo slugs are case-insensitive: payload "acme/app" must match
    // a configured "Acme/App" instead of dropping as other_repo.
    mocks.env.GITHUB_OWNER = "Acme";
    mocks.env.GITHUB_REPO = "App";
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run-x" });

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "dispatched", runId: "run-x" });
    expect(mockDispatchTriggerEvent).toHaveBeenCalled();
  });

  it("returns the delivery header as the diagnosticId on a rejected event", async () => {
    const response = await makeApp()(makeRequest({ repository: repo() }, "workflow_run"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "event_workflow_run",
      diagnosticId: "delivery-test",
    });
  });

  it("mints a uuid diagnosticId when the delivery header is absent", async () => {
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=whatever",
        "x-github-event": "workflow_run",
      },
      body: JSON.stringify({ repository: repo() }),
    });

    const response = await makeApp()(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reason).toBe("missing_delivery_id");
    expect(body.diagnosticId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("carries the diagnosticId in the 401 error data on a signature failure", async () => {
    mockVerifySignature.mockImplementationOnce(() => {
      throw new Error("invalid signature");
    });

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.data).toEqual({ diagnosticId: "delivery-test" });
  });

  it("logs exactly one trigger_ingestion_rejected on a rejected request", async () => {
    await makeApp()(makeRequest({ repository: repo() }, "workflow_run"));

    const rejectedLogs = loggerInfo.mock.calls.filter(
      ([, msg]) => msg === "trigger_ingestion_rejected",
    );
    expect(rejectedLogs).toHaveLength(1);
    expect(rejectedLogs[0][0]).toMatchObject({
      diagnosticId: "delivery-test",
      provider: "github",
      event: "workflow_run",
      reason: "event_workflow_run",
    });
  });

  it("does not log trigger_ingestion_rejected on a dispatched request", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_ok" });

    await makeApp()(makeRequest(reviewBody("commented"), "pull_request_review"));

    const rejectedInfo = loggerInfo.mock.calls.filter(
      ([, msg]) => msg === "trigger_ingestion_rejected",
    );
    const rejectedWarn = loggerWarn.mock.calls.filter(
      ([, msg]) => msg === "trigger_ingestion_rejected",
    );
    expect(rejectedInfo).toHaveLength(0);
    expect(rejectedWarn).toHaveLength(0);
  });
});
