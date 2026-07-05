import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    GITLAB_WEBHOOK_SECRET: "secret",
    GITLAB_PROJECT_ID: undefined as string | undefined,
  },
  getConfiguredVcsProviders: vi.fn(),
  listRepositories: vi.fn(),
}));

vi.mock("../../../env.js", () => ({
  env: mocks.env,
  getConfiguredVcsProviders: mocks.getConfiguredVcsProviders,
}));

const mockDispatchPostPrGateWebhook = vi.fn();
vi.mock("../../lib/post-pr-gate-dispatch.js", () => ({
  dispatchPostPrGateWebhook: (...args: any[]) => mockDispatchPostPrGateWebhook(...args),
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

function makeRequest(body: string, token = "secret"): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": token,
      "x-gitlab-event": "Merge Request Hook",
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

describe("POST /webhooks/gitlab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.GITLAB_PROJECT_ID = undefined;
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

  it("continues processing when repository scope lookup fails open", async () => {
    mocks.listRepositories.mockRejectedValueOnce(new Error("GitLab unavailable"));
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
    expect(mockDispatchPostPrGateWebhook).toHaveBeenCalled();
  });

  it("rejects invalid GitLab webhook tokens before dispatch", async () => {
    const response = await makeApp()(makeRequest(validMergeRequestPayload(), "wrong"));

    expect(response.status).toBe(401);
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });
});
