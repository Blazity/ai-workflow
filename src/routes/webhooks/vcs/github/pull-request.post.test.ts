import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { createApp, toWebHandler } from "h3";

const WEBHOOK_SECRET = "test-secret";
const GITHUB_OWNER = "test-org";
const GITHUB_REPO = "test-repo";

// Mock env BEFORE importing anything that transitively pulls it in.
vi.mock("../../../../../env.js", () => ({
  env: {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_OWNER,
    GITHUB_REPO,
  },
}));

const loadConfigMock = vi.fn();
vi.mock("../../../../lib/workflow-config.js", () => ({
  loadConfig: (...args: any[]) => loadConfigMock(...args),
}));

const dispatchReviewMock = vi.fn();
vi.mock("../../../../lib/dispatch-review.js", () => ({
  dispatchReview: (...args: any[]) => dispatchReviewMock(...args),
}));

// Silence logger output in tests
vi.mock("../../../../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const handler = (await import("./pull-request.post.js")).default;

function makeApp() {
  const app = createApp();
  app.use("/", handler);
  return toWebHandler(app);
}

function makeHmac(rawBody: string, secret = WEBHOOK_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

function makePayload(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    action: "opened",
    repository: {
      full_name: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      owner: { login: GITHUB_OWNER },
      name: GITHUB_REPO,
    },
    pull_request: {
      number: 42,
      head: { sha: "abc123", ref: "feature/my-branch" },
      labels: [],
    },
    ...overrides,
  };
}

function makeDefaultConfig(overrides: Record<string, any> = {}) {
  return {
    version: 1,
    review: {
      enabled: true,
      triggers: ["opened", "synchronize", "reopened", "labeled"],
      scope: { mode: "all" },
      default_ignore: [],
      limits: {},
      checks: [],
      ...overrides,
    },
  };
}

async function post(
  body: Record<string, any>,
  opts: {
    secret?: string;
    event?: string;
    sig?: string | null;
    omitSig?: boolean;
  } = {},
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const sig =
    opts.omitSig === true
      ? undefined
      : opts.sig !== undefined
        ? opts.sig ?? undefined
        : makeHmac(rawBody, opts.secret ?? WEBHOOK_SECRET);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": opts.event ?? "pull_request",
  };
  if (sig !== undefined) {
    headers["x-hub-signature-256"] = sig;
  }

  const app = makeApp();
  return app(
    new Request("http://localhost/", {
      method: "POST",
      headers,
      body: rawBody,
    }),
  );
}

describe("POST /webhooks/vcs/github/pull-request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockResolvedValue({ config: makeDefaultConfig(), configHash: "abc" });
    dispatchReviewMock.mockResolvedValue({ runId: "run_123" });
  });

  // --- HMAC / auth ---

  it("returns 200 and dispatches for a valid HMAC and accepted action", async () => {
    const res = await post(makePayload());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("dispatched");
    expect(json.runId).toBe("run_123");
    expect(json.prNumber).toBe(42);
    expect(json.headSha).toBe("abc123");
    expect(dispatchReviewMock).toHaveBeenCalledOnce();
  });

  it("returns 401 when HMAC is signed with a different secret", async () => {
    const res = await post(makePayload(), { secret: "wrong-secret" });
    expect(res.status).toBe(401);
    expect(dispatchReviewMock).not.toHaveBeenCalled();
  });

  it("returns 401 when X-Hub-Signature-256 header is missing entirely", async () => {
    const res = await post(makePayload(), { omitSig: true });
    expect(res.status).toBe(401);
  });

  it("returns 401 when X-Hub-Signature-256 header has no sha256= prefix", async () => {
    const res = await post(makePayload(), { sig: "invalid-no-prefix" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when body has valid HMAC but malformed JSON", async () => {
    const rawBody = "{ this is not: valid json ";
    const sig = makeHmac(rawBody);
    const app = makeApp();
    const res = await app(
      new Request("http://localhost/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-abc",
          "x-hub-signature-256": sig,
        },
        body: rawBody,
      }),
    );
    expect(res.status).toBe(400);
    expect(dispatchReviewMock).not.toHaveBeenCalled();
  });

  it("returns 503 when GITHUB_WEBHOOK_SECRET is unset", async () => {
    const { env } = await import("../../../../../env.js");
    const original = (env as any).GITHUB_WEBHOOK_SECRET;
    (env as any).GITHUB_WEBHOOK_SECRET = undefined;
    try {
      const res = await post(makePayload());
      expect(res.status).toBe(503);
    } finally {
      (env as any).GITHUB_WEBHOOK_SECRET = original;
    }
  });

  // --- Event type ---

  it("returns 200 ignored wrong_event when X-GitHub-Event is not pull_request", async () => {
    const res = await post(makePayload(), { event: "push" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(json.reason).toBe("wrong_event");
    expect(dispatchReviewMock).not.toHaveBeenCalled();
  });

  // --- Action filtering ---

  it("returns 200 ignored unsupported_action when action is 'edited'", async () => {
    const res = await post(makePayload({ action: "edited" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(json.reason).toBe("unsupported_action");
    expect(dispatchReviewMock).not.toHaveBeenCalled();
  });

  // --- Config flags ---

  it("returns 200 ignored review_disabled when config.review.enabled is false (HMAC already verified)", async () => {
    loadConfigMock.mockResolvedValue({
      config: makeDefaultConfig({ enabled: false }),
      configHash: "abc",
    });
    const res = await post(makePayload());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(json.reason).toBe("review_disabled");
    expect(dispatchReviewMock).not.toHaveBeenCalled();
    // loadConfig was still called — meaning HMAC verification succeeded first
    expect(loadConfigMock).toHaveBeenCalled();
  });

  // --- Repo matching ---

  it("returns 200 ignored wrong_repo when repository.full_name does not match GITHUB_OWNER/GITHUB_REPO", async () => {
    const res = await post(
      makePayload({
        repository: {
          full_name: "other-org/other-repo",
          owner: { login: "other-org" },
          name: "other-repo",
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(json.reason).toBe("wrong_repo");
  });

  // --- Triggers ---

  it("returns 200 ignored when action is not listed in config.review.triggers", async () => {
    loadConfigMock.mockResolvedValue({
      config: makeDefaultConfig({ triggers: ["opened"] }),
      configHash: "abc",
    });
    const res = await post(makePayload({ action: "synchronize" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(dispatchReviewMock).not.toHaveBeenCalled();
  });

  // --- Scope: label ---

  it("dispatches when scope.mode=label and PR has the required label", async () => {
    loadConfigMock.mockResolvedValue({
      config: makeDefaultConfig({ scope: { mode: "label", label: "ai-review" } }),
      configHash: "abc",
    });
    const res = await post(
      makePayload({
        pull_request: {
          number: 42,
          head: { sha: "abc123", ref: "feature/x" },
          labels: [{ name: "ai-review" }, { name: "bug" }],
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("dispatched");
    expect(dispatchReviewMock).toHaveBeenCalledOnce();
  });

  it("returns 200 ignored out_of_scope when scope.mode=label and PR does not have the label", async () => {
    loadConfigMock.mockResolvedValue({
      config: makeDefaultConfig({ scope: { mode: "label", label: "ai-review" } }),
      configHash: "abc",
    });
    const res = await post(
      makePayload({
        pull_request: {
          number: 42,
          head: { sha: "abc123", ref: "feature/x" },
          labels: [{ name: "bug" }],
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(json.reason).toBe("out_of_scope");
    expect(dispatchReviewMock).not.toHaveBeenCalled();
  });

  // --- Scope: branch_prefix ---

  it("dispatches when scope.mode=branch_prefix and head ref matches", async () => {
    loadConfigMock.mockResolvedValue({
      config: makeDefaultConfig({ scope: { mode: "branch_prefix", branch_prefix: "feature/" } }),
      configHash: "abc",
    });
    const res = await post(
      makePayload({
        pull_request: {
          number: 42,
          head: { sha: "abc123", ref: "feature/my-work" },
          labels: [],
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("dispatched");
    expect(dispatchReviewMock).toHaveBeenCalledOnce();
  });

  it("returns 200 ignored out_of_scope when scope.mode=branch_prefix and head ref does not match", async () => {
    loadConfigMock.mockResolvedValue({
      config: makeDefaultConfig({ scope: { mode: "branch_prefix", branch_prefix: "feature/" } }),
      configHash: "abc",
    });
    const res = await post(
      makePayload({
        pull_request: {
          number: 42,
          head: { sha: "abc123", ref: "fix/some-bug" },
          labels: [],
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(json.reason).toBe("out_of_scope");
    expect(dispatchReviewMock).not.toHaveBeenCalled();
  });

  // --- Payload shape validation ---

  it("returns 400 (not 500) when action is accepted but repository.owner.login is missing", async () => {
    // accepted action + matching full_name passes the action and repo filters,
    // but the nested owner.login is missing — must surface as 400, not crash to 500.
    const res = await post(
      makePayload({
        repository: {
          full_name: `${GITHUB_OWNER}/${GITHUB_REPO}`,
          // owner intentionally omitted
          name: GITHUB_REPO,
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(dispatchReviewMock).not.toHaveBeenCalled();
  });

  // --- Scope: all ---

  it("dispatches when scope.mode=all regardless of labels or branch", async () => {
    loadConfigMock.mockResolvedValue({
      config: makeDefaultConfig({ scope: { mode: "all" } }),
      configHash: "abc",
    });
    const res = await post(
      makePayload({
        pull_request: {
          number: 7,
          head: { sha: "def456", ref: "hotfix/urgent" },
          labels: [],
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("dispatched");
    expect(dispatchReviewMock).toHaveBeenCalledOnce();
    expect(dispatchReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        prNumber: 7,
        headSha: "def456",
        action: "opened",
      }),
    );
  });
});
