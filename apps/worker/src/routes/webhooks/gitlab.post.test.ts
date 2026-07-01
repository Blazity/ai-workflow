import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../env.js", () => ({
  env: {
    GITLAB_WEBHOOK_SECRET: "secret",
    GITLAB_PROJECT_ID: "group/demo",
  },
}));

const mockDispatchPostPrGateWebhook = vi.fn();
vi.mock("../../lib/post-pr-gate-dispatch.js", () => ({
  dispatchPostPrGateWebhook: (...args: any[]) => mockDispatchPostPrGateWebhook(...args),
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
      },
    });
  });

  it("rejects invalid GitLab webhook tokens before dispatch", async () => {
    const response = await makeApp()(makeRequest(validMergeRequestPayload(), "wrong"));

    expect(response.status).toBe(401);
    expect(mockDispatchPostPrGateWebhook).not.toHaveBeenCalled();
  });
});
