import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    GITHUB_WEBHOOK_SECRET: "secret",
    GITHUB_OWNER: undefined as string | undefined,
    GITHUB_REPO: undefined as string | undefined,
    MAX_CONCURRENT_AGENTS: 3,
    VCS_BOT_LOGIN: undefined as string | undefined,
  },
}));

vi.mock("../../../env.js", () => ({ env: mocks.env }));

vi.mock("../../lib/github-webhook-sig.js", () => ({
  verifyGitHubWebhookSignature: vi.fn(),
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
    },
    body: JSON.stringify(body),
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

describe("POST /webhooks/github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.GITHUB_OWNER = undefined;
    mocks.env.GITHUB_REPO = undefined;
    mockDispatchPostPrGateWebhook.mockResolvedValue({ status: "dispatched", runId: "gate_run" });
    mockDispatchTriggerEvent.mockResolvedValue({ result: "no_definition" });
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
        name: "ci / build",
        conclusion: "failure",
        pull_requests: [
          { number: 7, head: { ref: "blazebot/aiw-1", sha: "abc123" }, base: { ref: "main" } },
        ],
      },
    };

    const response = await makeApp()(makeRequest(checkRunBody, "check_run"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "no_definition" });
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "trigger_pr_checks_failed" }),
      expect.anything(),
    );
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("returns 503 so GitHub redelivers when dispatch is at capacity", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "at_capacity" });

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(503);
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("returns 503 so GitHub redelivers when dispatch errors", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "error" });

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(503);
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("returns 200 without gating when a live run coalesces the delivery", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "coalesced" });

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "coalesced" });
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("ignores unsupported pull_request actions", async () => {
    const response = await makeApp()(makeRequest(pullRequestBody("closed")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "action_closed" });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("skips events from other repositories", async () => {
    mocks.env.GITHUB_OWNER = "other";
    mocks.env.GITHUB_REPO = "repo";

    const response = await makeApp()(makeRequest(pullRequestBody("opened")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "other_repo" });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });
});
