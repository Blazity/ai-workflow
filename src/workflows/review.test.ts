/**
 * review.test.ts
 *
 * Unit tests for reviewWorkflow. Vitest does not enforce "use workflow" /
 * "use step" directives — those are compiled/sandboxed by the Workflow
 * runtime, not by the test runner. We call reviewWorkflow as a plain async
 * function and mock all I/O modules.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CheckResult } from "../lib/checks/types.js";
import type { CheckRunRef } from "../adapters/vcs/types.js";

// ---------------------------------------------------------------------------
// Mock: env / VCS config
// ---------------------------------------------------------------------------
const DEFAULT_VCS_CONFIG = {
  kind: "github",
  auth: { appId: 1, privateKeyBase64: "base64key", installationId: 99 },
  owner: "test-org",
  repo: "test-repo",
  baseBranch: "main",
  repoPath: "test-org/test-repo",
  host: "https://github.com",
} as Record<string, unknown>;
const getVcsConfigMock = vi.fn(() => DEFAULT_VCS_CONFIG);
vi.mock("../../env.js", () => ({
  getVcsConfig: () => getVcsConfigMock(),
}));

// ---------------------------------------------------------------------------
// Mock: workflow-config
// ---------------------------------------------------------------------------
const loadConfigMock = vi.fn();
vi.mock("../lib/workflow-config.js", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
}));

// ---------------------------------------------------------------------------
// Mock: pr-context
// ---------------------------------------------------------------------------
const buildReviewBundleMock = vi.fn();
vi.mock("../lib/pr-context.js", () => ({
  buildReviewBundle: (...args: unknown[]) => buildReviewBundleMock(...args),
}));

// ---------------------------------------------------------------------------
// Mock: GitHubAdapter + buildCheckRunExternalId
// ---------------------------------------------------------------------------
const listCheckRunsForRefMock = vi.fn();
const createCheckRunMock = vi.fn();
const updateCheckRunMock = vi.fn();
const listExistingReviewCommentsMock = vi.fn();
const createReviewMock = vi.fn();
const listCheckRunAnnotationsMock = vi.fn();
const getPullRequestMock = vi.fn();

const mockVcsInstance = {
  listCheckRunsForRef: listCheckRunsForRefMock,
  createCheckRun: createCheckRunMock,
  updateCheckRun: updateCheckRunMock,
  listExistingReviewComments: listExistingReviewCommentsMock,
  createReview: createReviewMock,
  listCheckRunAnnotations: listCheckRunAnnotationsMock,
  getPullRequest: getPullRequestMock,
};

vi.mock("../adapters/vcs/github.js", () => ({
  GitHubAdapter: vi.fn(() => mockVcsInstance),
  buildCheckRunExternalId: (configHash: string, checkId: string, headSha: string) =>
    `ai-workflow:${configHash}:${checkId}:${headSha}`,
}));

// ---------------------------------------------------------------------------
// Mock: check registry + check implementations
// ---------------------------------------------------------------------------
const getCheckMock = vi.fn();
vi.mock("../lib/checks/registry.js", () => ({
  getCheck: (...args: unknown[]) => getCheckMock(...args),
}));

// Side-effect imports — must resolve without error but we don't need the real logic
vi.mock("../lib/checks/complexity.js", () => ({}));
vi.mock("../lib/checks/ai-review.js", () => ({}));

// ---------------------------------------------------------------------------
// Mock: check-output
// ---------------------------------------------------------------------------
vi.mock("../lib/check-output.js", () => ({
  findingsToAnnotations: vi.fn((_findings: unknown, _caps: unknown) => ({
    annotations: [],
    overflow_text: "",
    unanchored: [],
  })),
  findingsToComments: vi.fn(() => ({
    comments: [],
    suggestions: [],
    skipped_duplicates: 0,
    dropped_by_cap: 0,
    invalid_suggestions: [],
  })),
  formatFindingMarker: vi.fn((fp: string) => `<!-- ai-workflow:finding:${fp} -->`),
}));

// ---------------------------------------------------------------------------
// Mock: checks/result
// ---------------------------------------------------------------------------
vi.mock("../lib/checks/result.js", () => ({
  mapFindingsToConclusion: vi.fn(
    (findings: Array<{ severity: string }>, opts: { blocking: boolean; fail_on: string }) => {
      if (findings.length === 0) return "success";
      const RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };
      const top = findings.reduce(
        (m, f) => (RANK[f.severity] ?? 0) > (RANK[m] ?? 0) ? f.severity : m,
        "info",
      );
      const meets = (RANK[top] ?? 0) >= (RANK[opts.fail_on] ?? 0);
      if (!meets) return "neutral";
      return opts.blocking ? "failure" : "neutral";
    },
  ),
  severityRank: (s: string) => ({ info: 0, warning: 1, critical: 2 }[s] ?? 0),
}));

// ---------------------------------------------------------------------------
// Mock: checks/cache
// ---------------------------------------------------------------------------
vi.mock("../lib/checks/cache.js", () => ({
  parseCacheManifest: vi.fn(() => null),
  serializeCacheManifest: vi.fn(() => "<!-- ai-workflow-cache\n{}\n-->"),
  isCacheEntryValid: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Mock: prompts-step
// ---------------------------------------------------------------------------
vi.mock("./prompts-step.js", () => ({
  loadReviewPrompt: vi.fn(async () => ({
    body: "You are a code reviewer.",
    source_kind: "builtin",
    source_id: "builtin:pr-review",
    hash: "abc123",
    fallback_used: false,
  })),
}));

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------
const logInfoMock = vi.fn();
const logWarnMock = vi.fn();
const logErrorMock = vi.fn();
vi.mock("../lib/logger.js", () => ({
  logger: {
    child: vi.fn(() => ({
      info: logInfoMock,
      warn: logWarnMock,
      error: logErrorMock,
      debug: vi.fn(),
    })),
    info: logInfoMock,
    warn: logWarnMock,
    error: logErrorMock,
  },
}));

// ---------------------------------------------------------------------------
// Import SUT after all mocks are set up
// ---------------------------------------------------------------------------
const { reviewWorkflow } = await import("./review.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_ARGS = {
  owner: "test-org",
  repo: "test-repo",
  prNumber: 42,
  headSha: "sha-abc",
  action: "opened",
};

function makeCheckConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "complexity-check",
    kind: "complexity",
    name: "Complexity Check",
    enabled: true,
    blocking: true,
    fail_on: "critical",
    params: {},
    ...overrides,
  };
}

function makeConfig(checksOverride?: unknown[]) {
  return {
    version: 1 as const,
    review: {
      enabled: true,
      scope: { mode: "all" as const },
      triggers: ["opened" as const],
      default_ignore: [],
      limits: {
        max_changed_files: 50,
        max_total_diff_bytes: 500_000,
        max_file_content_bytes: 100_000,
        max_check_annotations: 50,
        max_review_comments: 10,
        max_suggestions: 5,
      },
      checks: checksOverride ?? [makeCheckConfig()],
    },
  };
}

function makeBundle() {
  return {
    pr: {
      owner: "test-org",
      repo: "test-repo",
      pr_number: 42,
      pr_url: "https://github.com/test-org/test-repo/pull/42",
      base_sha: "base-sha",
      head_sha: "sha-abc",
      labels: [],
    },
    pr_meta: {} as never,
    files: [],
    ignored_files: [],
    dropped_files: [],
    notices: [],
  };
}

function makeCheckResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    summary: "All good.",
    findings: [],
    notices: [],
    ...overrides,
  };
}

function makeCheckRunRef(overrides: Partial<CheckRunRef> = {}): CheckRunRef {
  return {
    id: 1001,
    external_id: null,
    name: "Complexity Check",
    head_sha: "sha-abc",
    status: "queued",
    conclusion: null,
    output_text: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// beforeEach: reset all mocks to sensible defaults
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();

  getVcsConfigMock.mockReturnValue(DEFAULT_VCS_CONFIG);

  loadConfigMock.mockResolvedValue({
    config: makeConfig(),
    configHash: "cfghash",
  });

  buildReviewBundleMock.mockResolvedValue(makeBundle());

  listCheckRunsForRefMock.mockResolvedValue([]);
  createCheckRunMock.mockResolvedValue(makeCheckRunRef());
  updateCheckRunMock.mockResolvedValue(makeCheckRunRef({ status: "completed", conclusion: "success" }));
  listExistingReviewCommentsMock.mockResolvedValue([]);
  createReviewMock.mockResolvedValue(undefined);
  listCheckRunAnnotationsMock.mockResolvedValue([]);
  // Default: PR head SHA still matches args.headSha (no staleness).
  getPullRequestMock.mockResolvedValue({
    owner: "test-org",
    repo: "test-repo",
    number: 42,
    url: "https://github.com/test-org/test-repo/pull/42",
    base: { ref: "main", sha: "base-sha" },
    head: { ref: "feature", sha: "sha-abc" },
    labels: [],
    title: "Test PR",
    body: null,
    draft: false,
    user: "tester",
  });

  getCheckMock.mockReturnValue({
    kind: "complexity",
    paramsSchema: { parse: (p: unknown) => p },
    run: vi.fn(async () => makeCheckResult()),
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reviewWorkflow", () => {
  // --- review.enabled: false → early return ---

  it("returns immediately when review.enabled is false", async () => {
    loadConfigMock.mockResolvedValue({
      config: makeConfig([makeCheckConfig()]),
      configHash: "cfghash",
    });
    // Mutate enabled after build
    const cfg = makeConfig([makeCheckConfig()]);
    cfg.review.enabled = false;
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    await reviewWorkflow(DEFAULT_ARGS);

    expect(buildReviewBundleMock).not.toHaveBeenCalled();
    expect(createCheckRunMock).not.toHaveBeenCalled();
    expect(logInfoMock).toHaveBeenCalledWith({}, "review_workflow_disabled");
  });

  // --- disabled check is skipped ---

  it("skips checks with enabled: false", async () => {
    const cfg = makeConfig([makeCheckConfig({ enabled: false })]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    await reviewWorkflow(DEFAULT_ARGS);

    // Bundle is not fetched since no enabled checks
    expect(buildReviewBundleMock).not.toHaveBeenCalled();
    expect(createCheckRunMock).not.toHaveBeenCalled();
  });

  // --- happy path: single check runs and completes ---

  it("creates, marks in_progress, runs check, and completes a check run", async () => {
    const checkRun = makeCheckRunRef({ id: 2000 });
    createCheckRunMock.mockResolvedValue(checkRun);

    const fakeRun = vi.fn(async () => makeCheckResult({ summary: "No issues.", findings: [] }));
    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: fakeRun,
    });

    await reviewWorkflow(DEFAULT_ARGS);

    // in_progress update
    expect(updateCheckRunMock).toHaveBeenCalledWith(
      2000,
      expect.objectContaining({ status: "in_progress" }),
    );

    // check was run
    expect(fakeRun).toHaveBeenCalledOnce();

    // completed update
    expect(updateCheckRunMock).toHaveBeenCalledWith(
      2000,
      expect.objectContaining({ status: "completed", conclusion: "success" }),
    );
  });

  // --- checks run in configured order ---

  it("runs 3 checks in defined order", async () => {
    const order: string[] = [];
    function makeOrderedCheck(id: string) {
      return {
        kind: "complexity",
        paramsSchema: { parse: (p: unknown) => p },
        run: vi.fn(async () => {
          order.push(id);
          return makeCheckResult();
        }),
      };
    }

    const checkA = makeCheckConfig({ id: "check-a", name: "A" });
    const checkB = makeCheckConfig({ id: "check-b", name: "B" });
    const checkC = makeCheckConfig({ id: "check-c", name: "C" });
    const cfg = makeConfig([checkA, checkB, checkC]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    // Assign unique check run IDs so updateCheckRunMock calls can be tracked
    let idCounter = 3000;
    createCheckRunMock.mockImplementation(() =>
      Promise.resolve(makeCheckRunRef({ id: idCounter++ })),
    );

    getCheckMock.mockImplementation((kind: string) => {
      // called 3 times; use order array length to determine which check
      const idx = order.length;
      return makeOrderedCheck(["check-a", "check-b", "check-c"][idx] ?? kind);
    });

    await reviewWorkflow(DEFAULT_ARGS);

    expect(order).toEqual(["check-a", "check-b", "check-c"]);
  });

  // --- dependency skip ---

  it("skips check B with neutral when check A (blocking) produces critical findings and B has skip_on_dependency_failure", async () => {
    const checkA = makeCheckConfig({
      id: "check-a",
      name: "Check A",
      blocking: true,
      fail_on: "critical",
    });
    const checkB = makeCheckConfig({
      id: "check-b",
      name: "Check B",
      needs: ["check-a"],
      skip_on_dependency_failure: true,
      blocking: false,
    });
    const cfg = makeConfig([checkA, checkB]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    const runAMock = vi.fn(async () =>
      makeCheckResult({
        findings: [{ severity: "critical", message: "Too complex", fingerprint: "fp1" }],
      }),
    );
    const runBMock = vi.fn(async () => makeCheckResult());

    // getCheck is called once per runCheckStep. First call = check A, second call = check B.
    // But check B should be skipped before runCheckStep is reached.
    let getCheckCallCount = 0;
    getCheckMock.mockImplementation(() => {
      const idx = getCheckCallCount++;
      return {
        kind: "complexity",
        paramsSchema: { parse: (p: unknown) => p },
        run: idx === 0 ? runAMock : runBMock,
      };
    });

    let checkRunIdCounter = 1000;
    createCheckRunMock.mockImplementation(() =>
      Promise.resolve(makeCheckRunRef({ id: checkRunIdCounter++ })),
    );

    await reviewWorkflow(DEFAULT_ARGS);

    // check A ran
    expect(runAMock).toHaveBeenCalledOnce();
    // check B was skipped — its run function never called
    expect(runBMock).not.toHaveBeenCalled();

    // A neutral completed check run was published (for the skip)
    const neutralCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) => upd.conclusion === "neutral" && upd.status === "completed",
    );
    expect(neutralCall).toBeDefined();
  });

  // --- independent continuation: check A throws, check B still runs ---

  it("continues to check B when check A throws internally", async () => {
    const checkA = makeCheckConfig({ id: "check-a", name: "Check A", blocking: true });
    const checkB = makeCheckConfig({ id: "check-b", name: "Check B", blocking: false });
    const cfg = makeConfig([checkA, checkB]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    const runBMock = vi.fn(async () => makeCheckResult());

    let callIndex = 0;
    getCheckMock.mockImplementation(() => {
      const idx = callIndex++;
      if (idx === 0) {
        return {
          kind: "complexity",
          paramsSchema: { parse: (p: unknown) => p },
          run: async () => {
            throw new Error("check A internal error");
          },
        };
      }
      return {
        kind: "complexity",
        paramsSchema: { parse: (p: unknown) => p },
        run: runBMock,
      };
    });

    createCheckRunMock.mockImplementation(() => {
      const id = createCheckRunMock.mock.calls.length * 1000 + 100;
      return Promise.resolve(makeCheckRunRef({ id }));
    });

    await reviewWorkflow(DEFAULT_ARGS);

    // Check B should have run
    expect(runBMock).toHaveBeenCalledOnce();

    // Error logged for check A
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ checkId: "check-a" }),
      "review_check_internal_error",
    );
  });

  // --- internal error path: failure vs neutral based on blocking ---

  it("publishes failure conclusion when blocking check throws internally", async () => {
    const checkA = makeCheckConfig({ id: "check-a", name: "Check A", blocking: true });
    const cfg = makeConfig([checkA]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () => {
        throw new Error("boom");
      },
    });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 5000 }));

    await reviewWorkflow(DEFAULT_ARGS);

    const failureCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) => upd.conclusion === "failure" && upd.status === "completed",
    );
    expect(failureCall).toBeDefined();
    expect(failureCall![1].output.summary).toBe("Check failed internally.");
  });

  it("publishes neutral conclusion when non-blocking check throws internally", async () => {
    const checkA = makeCheckConfig({ id: "check-a", name: "Check A", blocking: false });
    const cfg = makeConfig([checkA]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () => {
        throw new Error("boom");
      },
    });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 6000 }));

    await reviewWorkflow(DEFAULT_ARGS);

    const neutralCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) => upd.conclusion === "neutral" && upd.status === "completed",
    );
    expect(neutralCall).toBeDefined();
    expect(neutralCall![1].output.summary).toBe("Check failed internally.");
  });

  // --- same-SHA dedupe ---

  it("skips re-running a check when an existing completed check run with matching external_id exists", async () => {
    const externalId = `ai-workflow:cfghash:complexity-check:sha-abc`;
    listCheckRunsForRefMock.mockResolvedValue([
      makeCheckRunRef({
        id: 9999,
        external_id: externalId,
        status: "completed",
        conclusion: "success",
      }),
    ]);

    const runMock = vi.fn(async () => makeCheckResult());
    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: runMock,
    });

    await reviewWorkflow(DEFAULT_ARGS);

    // check should NOT have been run
    expect(runMock).not.toHaveBeenCalled();
    // no new check run created
    expect(createCheckRunMock).not.toHaveBeenCalled();

    expect(logInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ checkId: "complexity-check" }),
      "review_check_same_sha_dedupe",
    );
  });

  // --- conclusion mapping ---

  it("produces failure conclusion for blocking check with critical finding", async () => {
    const check = makeCheckConfig({ blocking: true, fail_on: "critical" });
    const cfg = makeConfig([check]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 7000 }));

    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () =>
        makeCheckResult({
          findings: [{ severity: "critical", message: "Too complex", fingerprint: "fp-c" }],
        }),
    });

    await reviewWorkflow(DEFAULT_ARGS);

    const completedCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) => upd.status === "completed",
    );
    expect(completedCall).toBeDefined();
    expect(completedCall![1].conclusion).toBe("failure");
  });

  it("produces neutral conclusion for non-blocking check with critical finding", async () => {
    const check = makeCheckConfig({ blocking: false, fail_on: "critical" });
    const cfg = makeConfig([check]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 7001 }));

    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () =>
        makeCheckResult({
          findings: [{ severity: "critical", message: "Too complex", fingerprint: "fp-c2" }],
        }),
    });

    await reviewWorkflow(DEFAULT_ARGS);

    const completedCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) => upd.status === "completed",
    );
    expect(completedCall).toBeDefined();
    expect(completedCall![1].conclusion).toBe("neutral");
  });

  // --- success conclusion when no findings ---

  it("produces success conclusion when there are no findings", async () => {
    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 8000 }));

    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () => makeCheckResult({ findings: [] }),
    });

    await reviewWorkflow(DEFAULT_ARGS);

    const completedCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) => upd.status === "completed",
    );
    expect(completedCall).toBeDefined();
    expect(completedCall![1].conclusion).toBe("success");
  });

  // --- buildBundleStep receives correct args ---

  it("passes owner, repo, prNumber to buildBundleStep", async () => {
    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 100 }));
    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () => makeCheckResult(),
    });

    const args = { ...DEFAULT_ARGS, owner: "my-org", repo: "my-repo", prNumber: 7 };
    await reviewWorkflow(args);

    expect(buildReviewBundleMock).toHaveBeenCalledWith(
      expect.anything(), // vcs adapter
      expect.objectContaining({ owner: "my-org", repo: "my-repo", prNumber: 7 }),
      expect.any(Object),
    );
  });

  // --- loadConfig called with requireWebhookSecret: true ---

  it("calls loadConfig with requireWebhookSecret: true", async () => {
    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 200 }));
    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () => makeCheckResult(),
    });

    await reviewWorkflow(DEFAULT_ARGS);

    expect(loadConfigMock).toHaveBeenCalledWith({ requireWebhookSecret: true });
  });

  // --- Bug 2: dependent check must re-run when its dependency would dedupe ---

  it("re-runs a same-SHA-deduped check when another enabled check depends on it", async () => {
    const checkA = makeCheckConfig({ id: "check-a", name: "Check A" });
    const checkB = makeCheckConfig({
      id: "check-b",
      name: "Check B",
      needs: ["check-a"],
      skip_on_dependency_failure: true,
    });
    const cfg = makeConfig([checkA, checkB]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    // Simulate "second webhook with same head SHA": Check A already has a
    // completed Check Run for this SHA + configHash. The workflow MUST NOT
    // dedupe it because Check B depends on it.
    const checkAExternalId = `ai-workflow:cfghash:check-a:sha-abc`;
    listCheckRunsForRefMock.mockResolvedValue([
      makeCheckRunRef({
        id: 11111,
        external_id: checkAExternalId,
        status: "completed",
        conclusion: "success",
      }),
    ]);

    const runAMock = vi.fn(async () => makeCheckResult({ summary: "A ok", findings: [] }));
    const runBMock = vi.fn(async () => makeCheckResult({ summary: "B ok", findings: [] }));

    let callIdx = 0;
    getCheckMock.mockImplementation(() => {
      const idx = callIdx++;
      return {
        kind: "complexity",
        paramsSchema: { parse: (p: unknown) => p },
        run: idx === 0 ? runAMock : runBMock,
      };
    });

    let crId = 4000;
    createCheckRunMock.mockImplementation(() =>
      Promise.resolve(makeCheckRunRef({ id: crId++ })),
    );

    await reviewWorkflow(DEFAULT_ARGS);

    // Both A and B must have run; B's dependency on A is satisfied.
    expect(runAMock).toHaveBeenCalledOnce();
    expect(runBMock).toHaveBeenCalledOnce();

    // No neutral "Skipped: dependency failed" Check Run was published for B.
    const skipCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) =>
        upd.conclusion === "neutral" &&
        upd.status === "completed" &&
        upd.output?.summary === "Skipped: a dependency check failed.",
    );
    expect(skipCall).toBeUndefined();
  });

  // --- Fix 1: buildCheckRequestedData for ai_review passes check_id and reuse_previous_annotations ---

  it("forwards check_id and reuse_previous_annotations into ai_review requested_data", async () => {
    const aiCheck = makeCheckConfig({
      id: "style-per-file",
      kind: "ai_review",
      name: "Style per file",
      params: {
        mode: "per_file",
        model: "claude-3-5-sonnet",
        prompt: { source: "builtin", name: "pr-review" },
        data: ["file_diff"],
      },
      cache: { mode: "per_file_content_hash", reuse_previous_annotations: false },
    });
    const cfg = makeConfig([aiCheck]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 9100 }));

    const runMock = vi.fn(async () => makeCheckResult());
    getCheckMock.mockReturnValue({
      kind: "ai_review",
      paramsSchema: { parse: (p: unknown) => p },
      run: runMock,
    });

    await reviewWorkflow(DEFAULT_ARGS);

    expect(runMock).toHaveBeenCalledOnce();
    const ctx = (runMock.mock.calls[0] as unknown as [unknown, { requested_data: Record<string, unknown> }])[1];
    expect(ctx.requested_data["check_id"]).toBe("style-per-file");
    expect(ctx.requested_data["reuse_previous_annotations"]).toBe(false);
  });

  it("omits reuse_previous_annotations when not set in config", async () => {
    const aiCheck = makeCheckConfig({
      id: "ai-no-cache-opt",
      kind: "ai_review",
      name: "AI no cache opt",
      params: {
        mode: "per_file",
        model: "claude-3-5-sonnet",
        prompt: { source: "builtin", name: "pr-review" },
        data: ["file_diff"],
      },
      // No `cache` config at all.
    });
    const cfg = makeConfig([aiCheck]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 9101 }));

    const runMock = vi.fn(async () => makeCheckResult());
    getCheckMock.mockReturnValue({
      kind: "ai_review",
      paramsSchema: { parse: (p: unknown) => p },
      run: runMock,
    });

    await reviewWorkflow(DEFAULT_ARGS);

    const ctx = (runMock.mock.calls[0] as unknown as [unknown, { requested_data: Record<string, unknown> }])[1];
    expect(ctx.requested_data["check_id"]).toBe("ai-no-cache-opt");
    expect("reuse_previous_annotations" in ctx.requested_data).toBe(false);
  });

  // --- Fix 2: buildCheckRequestedData for complexity forwards patch per file ---

  it("forwards patch on each file entry for complexity checks", async () => {
    const cfg = makeConfig([makeCheckConfig({ kind: "complexity" })]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    buildReviewBundleMock.mockResolvedValue({
      ...makeBundle(),
      files: [
        {
          path: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n-old\n+new",
          changed_line_ranges: [{ start: 1, end: 1 }],
        },
        {
          path: "src/b.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          // patch intentionally absent (oversized)
          changed_line_ranges: [],
        },
      ],
      file_contents: {
        "src/a.ts": { path: "src/a.ts", content: "const a = 1;" },
        "src/b.ts": { path: "src/b.ts", content: "const b = 2;" },
      },
    });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 9200 }));

    const runMock = vi.fn(async () => makeCheckResult());
    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: runMock,
    });

    await reviewWorkflow(DEFAULT_ARGS);

    expect(runMock).toHaveBeenCalledOnce();
    const ctx = (runMock.mock.calls[0] as unknown as [
      unknown,
      { requested_data: { files: Array<{ path: string; patch?: string }> } },
    ])[1];
    const files = ctx.requested_data.files;
    const a = files.find((f) => f.path === "src/a.ts");
    const b = files.find((f) => f.path === "src/b.ts");
    expect(a?.patch).toBe("@@ -1 +1 @@\n-old\n+new");
    expect(b?.patch).toBeUndefined();
  });

  // --- Fix 3: annotation copy-forward on cache hits ---

  it("copies forward annotations from previous_check_run_id for cache-hit files", async () => {
    const aiCheck = makeCheckConfig({
      id: "style-per-file",
      kind: "ai_review",
      name: "Style per file",
      params: {
        mode: "per_file",
        model: "claude-3-5-sonnet",
        prompt: { source: "builtin", name: "pr-review" },
        data: ["file_diff"],
      },
      cache: { mode: "per_file_content_hash" },
    });
    const cfg = makeConfig([aiCheck]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 9300 }));

    // The check returns a cache_manifest with one completed cache-hit file
    // pointing at previous_check_run_id 7777, and NO findings for that file.
    getCheckMock.mockReturnValue({
      kind: "ai_review",
      paramsSchema: { parse: (p: unknown) => p },
      run: vi.fn(async () =>
        makeCheckResult({
          summary: "Cached.",
          findings: [],
          cache_manifest: {
            cache_version: 1,
            check_id: "style-per-file",
            config_hash: "cfg",
            files: {
              "src/a.ts": {
                content_hash: "hash-a",
                status: "completed",
                finding_count: 1,
                previous_check_run_id: 7777,
              },
              "src/b.ts": {
                content_hash: "hash-b",
                status: "completed",
                finding_count: 0,
                // no previous_check_run_id → not copied forward
              },
            },
          },
        }),
      ),
    });

    // The prior Check Run had annotations on multiple files; we should
    // only carry forward those on src/a.ts.
    listCheckRunAnnotationsMock.mockResolvedValue([
      {
        path: "src/a.ts",
        start_line: 10,
        end_line: 10,
        annotation_level: "warning",
        message: "carry me forward",
      },
      {
        path: "src/other.ts",
        start_line: 5,
        end_line: 5,
        annotation_level: "warning",
        message: "must be filtered out",
      },
    ]);

    await reviewWorkflow(DEFAULT_ARGS);

    expect(listCheckRunAnnotationsMock).toHaveBeenCalledWith(7777);

    const completedCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) => upd.status === "completed" && upd.conclusion !== undefined,
    );
    expect(completedCall).toBeDefined();
    const annotations = completedCall![1].output.annotations as Array<{
      path: string;
      message: string;
    }>;
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      path: "src/a.ts",
      message: "carry me forward",
    });
  });

  it("respects max_check_annotations cap when copying forward cache-hit annotations", async () => {
    const aiCheck = makeCheckConfig({
      id: "style-per-file",
      kind: "ai_review",
      name: "Style per file",
      params: {
        mode: "per_file",
        model: "claude-3-5-sonnet",
        prompt: { source: "builtin", name: "pr-review" },
        data: ["file_diff"],
      },
      cache: { mode: "per_file_content_hash" },
    });
    const cfg = makeConfig([aiCheck]);
    // Set the cap low so we can verify truncation.
    cfg.review.limits.max_check_annotations = 2;
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 9400 }));

    getCheckMock.mockReturnValue({
      kind: "ai_review",
      paramsSchema: { parse: (p: unknown) => p },
      run: vi.fn(async () =>
        makeCheckResult({
          findings: [],
          cache_manifest: {
            cache_version: 1,
            check_id: "style-per-file",
            config_hash: "cfg",
            files: {
              "src/a.ts": {
                content_hash: "h",
                status: "completed",
                finding_count: 5,
                previous_check_run_id: 8888,
              },
            },
          },
        }),
      ),
    });

    listCheckRunAnnotationsMock.mockResolvedValue([
      { path: "src/a.ts", start_line: 1, end_line: 1, annotation_level: "warning", message: "1" },
      { path: "src/a.ts", start_line: 2, end_line: 2, annotation_level: "warning", message: "2" },
      { path: "src/a.ts", start_line: 3, end_line: 3, annotation_level: "warning", message: "3" },
      { path: "src/a.ts", start_line: 4, end_line: 4, annotation_level: "warning", message: "4" },
      { path: "src/a.ts", start_line: 5, end_line: 5, annotation_level: "warning", message: "5" },
    ]);

    await reviewWorkflow(DEFAULT_ARGS);

    const completedCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) => upd.status === "completed",
    );
    const annotations = completedCall![1].output.annotations as unknown[];
    expect(annotations.length).toBe(2);
  });

  // --- Fix 1: hoist listExistingReviewComments out of per-check loop ---

  it("fetches existing review comments at most once across multiple comment-enabled checks", async () => {
    const checkA = makeCheckConfig({
      id: "check-a",
      name: "A",
      comments: { enabled: true, severity_threshold: "warning" },
    });
    const checkB = makeCheckConfig({
      id: "check-b",
      name: "B",
      comments: { enabled: true, severity_threshold: "warning" },
    });
    const checkC = makeCheckConfig({
      id: "check-c",
      name: "C",
      comments: { enabled: true, severity_threshold: "warning" },
    });
    const cfg = makeConfig([checkA, checkB, checkC]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    let crId = 5500;
    createCheckRunMock.mockImplementation(() =>
      Promise.resolve(makeCheckRunRef({ id: crId++ })),
    );

    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () => makeCheckResult(),
    });

    await reviewWorkflow(DEFAULT_ARGS);

    expect(listExistingReviewCommentsMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch existing review comments when no check publishes comments", async () => {
    const checkA = makeCheckConfig({ id: "check-a", name: "A" });
    const cfg = makeConfig([checkA]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 5600 }));
    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () => makeCheckResult(),
    });

    await reviewWorkflow(DEFAULT_ARGS);

    expect(listExistingReviewCommentsMock).not.toHaveBeenCalled();
  });

  // --- Fix 2: outer catch must rethrow original error when failure-publish itself throws ---

  it("rethrows the original error when publishing the failure Check Run also fails", async () => {
    const checkA = makeCheckConfig({ id: "check-a", name: "Check A", blocking: true });
    const cfg = makeConfig([checkA]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    // Simulate the original failure being inside findOrCreateCheckRunStep —
    // listCheckRunsForRef throws (e.g., GitHub 403). The outer catch will
    // try to publish a failure Check Run, which re-invokes the same step
    // and throws again. The workflow MUST rethrow the original error.
    const originalErr = new Error("github 403 forbidden");
    listCheckRunsForRefMock.mockRejectedValue(originalErr);

    await expect(reviewWorkflow(DEFAULT_ARGS)).rejects.toThrow("github 403 forbidden");

    // Both errors must be logged at error level on the publish-failure path.
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        checkId: "check-a",
        err: "github 403 forbidden",
        publishErr: "github 403 forbidden",
      }),
      "review_check_publish_error_failed",
    );
  });

  // --- Staleness guard: PR head moved on while workflow ran ---

  it("skips review post and marks Check Run neutral when PR head SHA has moved on", async () => {
    const check = makeCheckConfig({
      id: "complexity-check",
      kind: "complexity",
      name: "Complexity Check",
      blocking: true,
      fail_on: "critical",
      comments: { enabled: true, severity_threshold: "warning" },
    });
    const cfg = makeConfig([check]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 9500 }));

    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () =>
        makeCheckResult({
          summary: "Found things",
          findings: [
            { severity: "warning", message: "issue", fingerprint: "fp-stale" },
          ],
        }),
    });

    // Simulate the user pushing a new commit while the workflow ran: PR head
    // SHA returned by getPullRequest no longer matches args.headSha.
    getPullRequestMock.mockResolvedValue({
      owner: "test-org",
      repo: "test-repo",
      number: 42,
      url: "https://github.com/test-org/test-repo/pull/42",
      base: { ref: "main", sha: "base-sha" },
      head: { ref: "feature", sha: "sha-NEWER" },
      labels: [],
      title: "Test PR",
      body: null,
      draft: false,
      user: "tester",
    });

    await reviewWorkflow(DEFAULT_ARGS);

    // No review must be created when the head SHA has moved on.
    expect(createReviewMock).not.toHaveBeenCalled();

    // The Check Run must be marked completed/neutral with the "Superseded"
    // summary — no annotations, no findings text.
    const supersededCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) =>
        upd.status === "completed" &&
        upd.conclusion === "neutral" &&
        upd.output?.summary === "Superseded by newer commit",
    );
    expect(supersededCall).toBeDefined();

    // Staleness must be logged.
    expect(logInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        checkId: "complexity-check",
        expected: "sha-abc",
        current: "sha-NEWER",
      }),
      "review_check_superseded",
    );
  });

  it("proceeds with posting when PR head fetch fails (conservative)", async () => {
    const check = makeCheckConfig({
      id: "complexity-check",
      kind: "complexity",
      name: "Complexity Check",
      blocking: true,
      fail_on: "critical",
    });
    const cfg = makeConfig([check]);
    loadConfigMock.mockResolvedValue({ config: cfg, configHash: "cfghash" });

    createCheckRunMock.mockResolvedValue(makeCheckRunRef({ id: 9501 }));

    getCheckMock.mockReturnValue({
      kind: "complexity",
      paramsSchema: { parse: (p: unknown) => p },
      run: async () => makeCheckResult(),
    });

    // Simulate transient API failure when fetching the PR.
    getPullRequestMock.mockRejectedValue(new Error("transient 502"));

    await reviewWorkflow(DEFAULT_ARGS);

    // No "Superseded" Check Run should be published — we proceed conservatively.
    const supersededCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) => upd.output?.summary === "Superseded by newer commit",
    );
    expect(supersededCall).toBeUndefined();

    // A normal completion must happen.
    const successCall = updateCheckRunMock.mock.calls.find(
      ([, upd]) => upd.status === "completed" && upd.conclusion === "success",
    );
    expect(successCall).toBeDefined();
  });

  // --- Bug 3: GitLab VCS with review.enabled=true must throw at workflow start ---

  it("throws when vcs kind is not github and review.enabled is true", async () => {
    getVcsConfigMock.mockReturnValue({
      ...DEFAULT_VCS_CONFIG,
      kind: "gitlab",
    });

    await expect(reviewWorkflow(DEFAULT_ARGS)).rejects.toThrow(
      /Review pipeline requires GITHUB VCS adapter; got: gitlab/,
    );

    // Pipeline must abort before fetching the bundle.
    expect(buildReviewBundleMock).not.toHaveBeenCalled();
    expect(createCheckRunMock).not.toHaveBeenCalled();
  });
});
