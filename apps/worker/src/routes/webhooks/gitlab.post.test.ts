import { createHash } from "node:crypto";
import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    GITLAB_WEBHOOK_SECRET: "secret",
    GITLAB_PROJECT_ID: undefined as string | undefined,
    MAX_CONCURRENT_AGENTS: 3,
    VCS_BOT_LOGIN: "blazebot",
    GITLAB_BOT_LOGIN: undefined as string | undefined,
  },
  getConfiguredVcsProviders: vi.fn(),
  getVcsBotLogin: vi.fn(),
  listRepositories: vi.fn(),
  fetch: vi.fn(),
  isRepoAllowed: vi.fn(),
}));

global.fetch = mocks.fetch;

vi.mock("../../../env.js", () => ({
  env: mocks.env,
  getConfiguredVcsProviders: mocks.getConfiguredVcsProviders,
  getVcsBotLogin: mocks.getVcsBotLogin,
}));

const mockDispatchPostPrGateWebhook = vi.fn();
vi.mock("../../lib/post-pr-gate-dispatch.js", () => ({
  dispatchPostPrGateWebhook: (...args: any[]) => mockDispatchPostPrGateWebhook(...args),
}));

const mockDispatchTriggerEvent = vi.fn();
const mockResolveEnabledReviewStates = vi.fn();
vi.mock("../../lib/dispatch-trigger.js", () => ({
  dispatchTriggerEvent: (...args: any[]) => mockDispatchTriggerEvent(...args),
  resolveEnabledReviewStates: (...args: any[]) => mockResolveEnabledReviewStates(...args),
}));

vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../../lib/repo-allowlist.js", () => ({
  isRepoAllowed: (...args: any[]) => mocks.isRepoAllowed(...args),
}));

vi.mock("../../adapters/vcs/repository-directory.js", () => ({
  createRepositoryDirectoryForProviders: vi.fn(() => ({
    listRepositories: mocks.listRepositories,
  })),
}));

const gitLabHandler = (await import("./gitlab.post.js")).default;

function makeApp() {
  const app = createApp();
  app.use("/", gitLabHandler);
  return toWebHandler(app);
}

function makeRequest(
  body: string,
  token = "secret",
  eventName = "Merge Request Hook",
  deliveryHeaders: Record<string, string> = {
    "x-gitlab-event-uuid": "delivery-test",
  },
): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": token,
      "x-gitlab-event": eventName,
      ...deliveryHeaders,
    },
    body,
  });
}

function validMergeRequestPayload(): string {
  return JSON.stringify({
    object_kind: "merge_request",
    user: { username: "alice" },
    project: {
      id: 123,
      path_with_namespace: "group/demo",
    },
    object_attributes: {
      iid: 42,
      action: "open",
      source_branch: "blazebot/AIW-32",
      target_branch: "main",
      title: "AIW-32 GitLab parity",
      description: "Body",
      url: "https://gitlab.com/group/demo/-/merge_requests/42",
      draft: false,
      work_in_progress: false,
      last_commit: { id: "sha1" },
    },
  });
}

function validNotePayload(overrides: Record<string, any> = {}): string {
  return JSON.stringify({
    object_kind: "note",
    event_type: "note",
    user: { id: 1, username: "alice" },
    project: {
      id: 5,
      path_with_namespace: "group/demo",
      web_url: "https://gitlab.example.com/group/demo",
    },
    object_attributes: {
      action: "create",
      noteable_type: "MergeRequest",
      note: "Please add coverage",
      system: false,
    },
    merge_request: {
      id: 7,
      iid: 42,
      author_id: 8,
      source_branch: "blazebot/AIW-32",
      target_branch: "main",
      title: "AIW-32 GitLab parity",
      last_commit: { id: "sha1" },
      draft: false,
    },
    ...overrides,
  });
}

describe("POST /webhooks/gitlab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.GITLAB_PROJECT_ID = undefined;
    mocks.env.GITLAB_BOT_LOGIN = undefined;
    mocks.getVcsBotLogin.mockReturnValue("blazebot");
    mocks.isRepoAllowed.mockReturnValue(true);
    mockDispatchTriggerEvent.mockResolvedValue({ result: "no_definition" });
    mockResolveEnabledReviewStates.mockReset().mockResolvedValue(["changes_requested"]);
    mocks.getConfiguredVcsProviders.mockReturnValue([
      {
        kind: "gitlab",
        token: "glpat",
        host: "https://gitlab.example.com",
        legacyBaseBranch: "main",
      },
    ]);
    mocks.listRepositories.mockResolvedValue([
      {
        provider: "gitlab",
        repoPath: "group/demo",
        name: "demo",
        owner: "group",
        defaultBranch: "main",
        description: "",
        webUrl: "https://gitlab.example.com/group/demo",
        topics: [],
        archived: false,
        private: true,
      },
    ]);
  });

  it("ignores invalid JSON as a malformed payload", async () => {
    const response = await makeApp()(makeRequest("{not-json"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "malformed_payload",
    });
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("uses webhook-id ahead of all legacy GitLab delivery headers", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_merge" });
    const payload = JSON.parse(validMergeRequestPayload());
    payload.object_attributes.action = "merge";

    await makeApp()(
      makeRequest(JSON.stringify(payload), "secret", "Merge Request Hook", {
        "webhook-id": "message-id",
        "idempotency-key": "legacy-message-id",
        "x-gitlab-event-uuid": "recursive-event-id",
        "x-gitlab-webhook-uuid": "webhook-config-id",
      }),
    );

    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ deliveryId: "message-id" }),
      }),
      expect.anything(),
    );
  });

  it("uses Idempotency-Key when webhook-id is unavailable", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_merge" });
    const payload = JSON.parse(validMergeRequestPayload());
    payload.object_attributes.action = "merge";

    await makeApp()(
      makeRequest(JSON.stringify(payload), "secret", "Merge Request Hook", {
        "idempotency-key": "legacy-message-id",
        "x-gitlab-event-uuid": "recursive-event-id",
      }),
    );

    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ deliveryId: "legacy-message-id" }),
      }),
      expect.anything(),
    );
  });

  it("hashes the event UUID and exact raw body for legacy delivery identity", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_merge" });
    const payload = JSON.parse(validMergeRequestPayload());
    payload.object_attributes.action = "merge";
    const rawBody = JSON.stringify(payload);
    const expected = createHash("sha256")
      .update("recursive-event-id\0")
      .update(rawBody)
      .digest("hex");

    await makeApp()(
      makeRequest(rawBody, "secret", "Merge Request Hook", {
        "x-gitlab-event-uuid": "recursive-event-id",
      }),
    );

    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ deliveryId: expected }),
      }),
      expect.anything(),
    );
  });

  it("does not use X-Gitlab-Webhook-UUID as a delivery id", async () => {
    const response = await makeApp()(
      makeRequest(validMergeRequestPayload(), "secret", "Merge Request Hook", {
        "x-gitlab-webhook-uuid": "webhook-config-id",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "missing_delivery_id",
    });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
  });

  it("dispatches a valid merge request webhook", async () => {
    mockDispatchPostPrGateWebhook.mockResolvedValueOnce({
      status: "dispatched",
      runId: "run_123",
    });

    const response = await makeApp()(makeRequest(validMergeRequestPayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "dispatched",
      runId: "run_123",
    });
    expect(mockDispatchPostPrGateWebhook).toHaveBeenCalledWith({
      action: "opened",
      workflowInput: {
        prNumber: 42,
        headSha: "sha1",
        headRef: "blazebot/AIW-32",
        baseRef: "main",
        title: "AIW-32 GitLab parity",
        body: "Body",
        author: "alice",
        isDraft: false,
        url: "https://gitlab.com/group/demo/-/merge_requests/42",
        ownerRepo: "group/demo",
        provider: "gitlab",
      },
    });
  });

  it("skips other projects when legacy GITLAB_PROJECT_ID is configured", async () => {
    mocks.env.GITLAB_PROJECT_ID = "group/allowed";

    const response = await makeApp()(makeRequest(validMergeRequestPayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "other_project",
    });
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("does not let a matching legacy project id bypass the hard repository allowlist", async () => {
    mocks.env.GITLAB_PROJECT_ID = "123";
    mocks.isRepoAllowed.mockReturnValueOnce(false);

    const response = await makeApp()(makeRequest(validMergeRequestPayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "other_project",
    });
    expect(mocks.isRepoAllowed).toHaveBeenCalledWith("group/demo");
    expect(mocks.listRepositories).not.toHaveBeenCalled();
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("skips projects outside the configured GitLab provider repository scope", async () => {
    mocks.listRepositories.mockResolvedValueOnce([
      {
        provider: "gitlab",
        repoPath: "group/allowed",
        name: "allowed",
        owner: "group",
        defaultBranch: "main",
        description: "",
        webUrl: "https://gitlab.example.com/group/allowed",
        topics: [],
        archived: false,
        private: true,
      },
    ]);

    const response = await makeApp()(makeRequest(validMergeRequestPayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "other_project",
    });
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("ignores unsupported actions before listing configured repositories", async () => {
    const payload = JSON.parse(validMergeRequestPayload());
    payload.object_attributes.action = "close";

    const response = await makeApp()(makeRequest(JSON.stringify(payload)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "action_close",
    });
    expect(mocks.listRepositories).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("returns a retryable failure when repository scope lookup is unavailable", async () => {
    mocks.listRepositories.mockRejectedValueOnce(new Error("GitLab unavailable"));

    const response = await makeApp()(makeRequest(validMergeRequestPayload()));

    expect(response.status).toBe(503);
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("returns a retryable failure when configured GitLab providers cannot be resolved", async () => {
    mocks.getConfiguredVcsProviders.mockImplementationOnce(() => {
      throw new Error("provider configuration unavailable");
    });

    const response = await makeApp()(makeRequest(validMergeRequestPayload()));

    expect(response.status).toBe(503);
    expect(mocks.listRepositories).not.toHaveBeenCalled();
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("rejects invalid GitLab webhook tokens before dispatch", async () => {
    const response = await makeApp()(makeRequest(validMergeRequestPayload(), "wrong"));

    expect(response.status).toBe(401);
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("supersedes the gate when a definition run starts for a bot MR", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_pr" });

    const response = await makeApp()(makeRequest(validMergeRequestPayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "dispatched",
      runId: "run_pr",
    });
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "trigger_pr_created" }),
      expect.anything(),
    );
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("keeps the gate for a non-bot MR that an enabled definition ignores", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "ignored_not_workflow_owned" });
    mockDispatchPostPrGateWebhook.mockResolvedValueOnce({
      status: "dispatched",
      runId: "gate_run",
    });

    const payload = JSON.parse(validMergeRequestPayload());
    payload.object_attributes.source_branch = "feature/x";

    const response = await makeApp()(makeRequest(JSON.stringify(payload)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "dispatched",
      runId: "gate_run",
    });
    expect(mockDispatchTriggerEvent).toHaveBeenCalled();
    expect(mockDispatchPostPrGateWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "opened",
        workflowInput: expect.objectContaining({ headRef: "feature/x" }),
      }),
    );
  });

  it("returns a retryable 503 when dispatch is at capacity", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "at_capacity" });

    const response = await makeApp()(makeRequest(validMergeRequestPayload()));

    expect(response.status).toBe(503);
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when dispatch errors", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "error" });

    const response = await makeApp()(makeRequest(validMergeRequestPayload()));

    expect(response.status).toBe(503);
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("returns 200 without gating when a live run coalesces the delivery", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "coalesced" });

    const response = await makeApp()(makeRequest(validMergeRequestPayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "coalesced" });
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("routes a failed pipeline hook to the checks-failed trigger", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_checks" });

    const pipelinePayload = JSON.stringify({
      object_kind: "pipeline",
      user: { username: "alice" },
      project: { id: 123, path_with_namespace: "group/demo" },
      object_attributes: { status: "failed", sha: "sha1" },
      merge_request: {
        iid: 42,
        source_branch: "blazebot/AIW-32",
        target_branch: "main",
        title: "AIW-32",
        url: "https://gitlab.com/group/demo/-/merge_requests/42",
      },
      builds: [{ name: "lint", status: "failed" }],
    });

    const request = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-token": "secret",
        "x-gitlab-event": "Pipeline Hook",
        "x-gitlab-event-uuid": "delivery-pipeline-test",
      },
      body: pipelinePayload,
    });

    const response = await makeApp()(request);

    expect(response.status).toBe(200);
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "trigger_pr_checks_failed" }),
      expect.anything(),
    );
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("routes a merged merge request to the merged trigger without invoking the legacy gate", async () => {
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_merged" });
    const payload = JSON.parse(validMergeRequestPayload());
    payload.object_attributes.action = "merge";
    payload.object_attributes.merge_commit_sha = "merge-sha";

    const response = await makeApp()(makeRequest(JSON.stringify(payload)));

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

  it("does not invoke the legacy gate when no definition handles a merged merge request", async () => {
    const payload = JSON.parse(validMergeRequestPayload());
    payload.object_attributes.action = "merge";
    payload.object_attributes.merge_commit_sha = "merge-sha";

    const response = await makeApp()(makeRequest(JSON.stringify(payload)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ignored", reason: "no_definition" });
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });

  it("routes an opted-in merge-request note through the common review trigger", async () => {
    mockResolveEnabledReviewStates.mockResolvedValueOnce(["commented"]);
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_note" });

    const response = await makeApp()(makeRequest(validNotePayload(), "secret", "Note Hook"));

    expect(response.status).toBe(200);
    expect(mockResolveEnabledReviewStates).toHaveBeenCalled();
    expect(mockResolveEnabledReviewStates).toHaveBeenCalledWith(
      expect.anything(),
      "gitlab",
      "blazebot",
    );
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "trigger_pr_review",
        pr: expect.objectContaining({
          prUrl: "https://gitlab.example.com/group/demo/-/merge_requests/42",
          author: "8",
          review: { state: "commented", author: "alice", body: "Please add coverage" },
        }),
      }),
      expect.anything(),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("fails closed on an internal merge-request note before normalization", async () => {
    mockResolveEnabledReviewStates.mockResolvedValueOnce(["commented"]);
    const note = JSON.parse(validNotePayload());
    note.object_attributes.internal = true;

    const response = await makeApp()(
      makeRequest(JSON.stringify(note), "secret", "Note Hook"),
    );

    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "note_ignored",
    });
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
    expect(mockResolveEnabledReviewStates).not.toHaveBeenCalled();
    expect(mocks.listRepositories).not.toHaveBeenCalled();
  });

  it("always treats an eligible GitLab note as commented without reviewer enrichment", async () => {
    mockResolveEnabledReviewStates.mockResolvedValueOnce(["changes_requested", "commented"]);
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_changes" });

    const response = await makeApp()(makeRequest(validNotePayload(), "secret", "Note Hook"));

    expect(response.status).toBe(200);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mockDispatchTriggerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "trigger_pr_review",
        pr: expect.objectContaining({
          review: {
            state: "commented",
            author: "alice",
            body: "Please add coverage",
          },
        }),
      }),
      expect.anything(),
    );
  });

  it("has no reviewer API dependency for GitLab notes", async () => {
    mockResolveEnabledReviewStates.mockResolvedValueOnce(["commented"]);
    mocks.fetch.mockRejectedValueOnce(new Error("GitLab unavailable"));
    mockDispatchTriggerEvent.mockResolvedValueOnce({ result: "started", runId: "run_note" });

    const response = await makeApp()(makeRequest(validNotePayload(), "secret", "Note Hook"));

    expect(response.status).toBe(200);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mockDispatchTriggerEvent).toHaveBeenCalled();
  });

  it("filters notes using the GitLab-specific bot login", async () => {
    mocks.env.GITLAB_BOT_LOGIN = "gitlab-automation";
    mocks.getVcsBotLogin.mockReturnValueOnce("gitlab-automation");
    mockResolveEnabledReviewStates.mockResolvedValueOnce(["commented"]);
    const note = JSON.parse(validNotePayload());
    note.user = { id: 9, username: "gitlab-automation" };

    const response = await makeApp()(makeRequest(JSON.stringify(note), "secret", "Note Hook"));

    expect(response.status).toBe(200);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
  });

  it("falls back to the legacy VCS bot login for GitLab notes", async () => {
    mocks.getVcsBotLogin.mockReturnValueOnce("blazebot");
    mockResolveEnabledReviewStates.mockResolvedValueOnce(["commented"]);
    const note = JSON.parse(validNotePayload());
    note.user = { id: 9, username: "blazebot" };

    const response = await makeApp()(makeRequest(JSON.stringify(note), "secret", "Note Hook"));

    expect(response.status).toBe(200);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
  });

  it("ignores a merge-request note when commented reviews are not configured", async () => {
    const response = await makeApp()(makeRequest(validNotePayload(), "secret", "Note Hook"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "note_ignored",
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mockDispatchTriggerEvent).not.toHaveBeenCalled();
  });
});
