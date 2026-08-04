import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAcquireLock = vi.fn();
const mockGetDedupe = vi.fn();
const mockGetCurrent = vi.fn();
const mockSetCurrent = vi.fn();
const mockClaimRun = vi.fn();
const mockUpdateRunIdIfHeadSha = vi.fn();
const mockReleaseLock = vi.fn();
const mockStart = vi.fn();
const mockGetRun = vi.fn();
const mockGetEnabledDefinition = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();

vi.mock("workflow/api", () => ({
  start: (...args: any[]) => mockStart(...args),
  getRun: (...args: any[]) => mockGetRun(...args),
}));

vi.mock("../db/client.js", () => ({
  getDb: vi.fn(() => "db"),
}));

vi.mock("../post-pr-gate/config.js", () => ({
  loadPostPrGateConfig: vi.fn(() => ({
    postPrGate: {
      runOn: { botPrsOnly: true, draftPrs: false, baseBranches: [] },
      steps: [],
    },
  })),
}));

vi.mock("../workflow-definition/store.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) =>
    mockGetEnabledDefinition(...args),
}));

vi.mock("./logger.js", () => ({
  logger: {
    warn: (...args: any[]) => mockLoggerWarn(...args),
    info: (...args: any[]) => mockLoggerInfo(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../post-pr-gate/gate-store.js", () => ({
  GateStore: vi.fn(() => ({
    acquireLock: mockAcquireLock,
    getCurrent: mockGetCurrent,
    getDedupe: mockGetDedupe,
    setCurrent: mockSetCurrent,
    claimRun: mockClaimRun,
    updateRunIdIfHeadSha: mockUpdateRunIdIfHeadSha,
    releaseLock: mockReleaseLock,
  })),
}));

vi.mock("./adapters.js", () => ({
  createAdapters: vi.fn(),
}));

vi.mock("../workflows/post-pr-gate.js", () => ({
  postPrGateWorkflow: vi.fn(),
}));

const { dispatchPostPrGateWebhook } = await import("./post-pr-gate-dispatch.js");

const workflowInput = {
  prNumber: 42,
  headSha: "sha1",
  headRef: "ai-workflow/AIW-220",
  baseRef: "main",
  title: "AIW-220",
  body: "",
  author: "blazebot",
  isDraft: false,
  url: "https://github.com/acme/demo/pull/42",
  ownerRepo: "acme/demo",
  provider: "github" as const,
};

/** Resolves an enabled definition for exactly the listed trigger types. */
function enableDefinitionsFor(triggerTypes: string[]): void {
  mockGetEnabledDefinition.mockImplementation(async (_db: unknown, type: string) =>
    triggerTypes.includes(type) ? { current: { definition: {} } } : null,
  );
}

function deprecationWarnings(): any[] {
  return mockLoggerWarn.mock.calls.filter(
    (call) => call[1] === "post_pr_gate_deprecated",
  );
}

/** Everything the dispatcher decides or mutates, so parity can be asserted. */
function dispatchFootprint() {
  return {
    acquireLock: mockAcquireLock.mock.calls,
    getDedupe: mockGetDedupe.mock.calls,
    getCurrent: mockGetCurrent.mock.calls,
    setCurrent: mockSetCurrent.mock.calls,
    claimRun: mockClaimRun.mock.calls,
    updateRunIdIfHeadSha: mockUpdateRunIdIfHeadSha.mock.calls,
    releaseLock: mockReleaseLock.mock.calls,
    startCount: mockStart.mock.calls.length,
    startArgs: mockStart.mock.calls.map((call) => call[1]),
  };
}

describe("post-pr-gate deprecation warning coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue("lock-token");
    mockGetCurrent.mockResolvedValue(null);
    mockGetDedupe.mockResolvedValue(null);
    mockStart.mockResolvedValue({ runId: "run_123" });
    mockClaimRun.mockResolvedValue(null);
    mockUpdateRunIdIfHeadSha.mockResolvedValue(true);
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
    mockGetEnabledDefinition.mockResolvedValue(null);
  });

  it("warns when an enabled definition owns trigger_pr_ready", async () => {
    enableDefinitionsFor(["trigger_pr_ready"]);

    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput,
    });

    expect(result).toEqual({ status: "dispatched", runId: "run_123" });
    expect(deprecationWarnings()).toEqual([
      [{ triggerType: "trigger_pr_ready" }, "post_pr_gate_deprecated"],
    ]);
  });

  it("warns when an enabled definition owns trigger_pr_updated", async () => {
    enableDefinitionsFor(["trigger_pr_updated"]);

    const result = await dispatchPostPrGateWebhook({
      action: "synchronize",
      workflowInput,
    });

    expect(result).toEqual({ status: "dispatched", runId: "run_123" });
    expect(deprecationWarnings()).toEqual([
      [{ triggerType: "trigger_pr_updated" }, "post_pr_gate_deprecated"],
    ]);
  });

  it("warns for the Post-PR review template, which declares both triggers", async () => {
    enableDefinitionsFor(["trigger_pr_ready", "trigger_pr_updated"]);

    await dispatchPostPrGateWebhook({ action: "opened", workflowInput });

    // First match wins, and the loop returns, so exactly one line is emitted.
    expect(deprecationWarnings()).toEqual([
      [{ triggerType: "trigger_pr_ready" }, "post_pr_gate_deprecated"],
    ]);
  });

  it("stays silent when no definition owns any PR trigger", async () => {
    enableDefinitionsFor([]);

    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput,
    });

    expect(result).toEqual({ status: "dispatched", runId: "run_123" });
    expect(deprecationWarnings()).toEqual([]);
  });

  it("queries every PR trigger type including the two added ones", async () => {
    enableDefinitionsFor([]);

    await dispatchPostPrGateWebhook({ action: "opened", workflowInput });

    expect(mockGetEnabledDefinition.mock.calls.map((call) => call[1])).toEqual([
      "trigger_pr_created",
      "trigger_pr_ready",
      "trigger_pr_updated",
      "trigger_pr_checks_failed",
      "trigger_pr_review",
    ]);
  });

  it("produces an identical dispatch outcome whether or not the added types match", async () => {
    // Baseline: no definition matches any trigger type. This is exactly what the
    // constant produced before trigger_pr_ready / trigger_pr_updated were added,
    // because neither was ever looked up.
    enableDefinitionsFor([]);
    const baselineResult = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput,
    });
    const baselineFootprint = dispatchFootprint();

    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue("lock-token");
    mockGetCurrent.mockResolvedValue(null);
    mockGetDedupe.mockResolvedValue(null);
    mockStart.mockResolvedValue({ runId: "run_123" });
    mockClaimRun.mockResolvedValue(null);
    mockUpdateRunIdIfHeadSha.mockResolvedValue(true);

    enableDefinitionsFor(["trigger_pr_ready", "trigger_pr_updated"]);
    const supersededResult = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput,
    });

    expect(supersededResult).toEqual(baselineResult);
    expect(dispatchFootprint()).toEqual(baselineFootprint);
    expect(deprecationWarnings()).toHaveLength(1);
  });

  it("still dispatches when the added lookups throw", async () => {
    mockGetEnabledDefinition.mockRejectedValue(new Error("db down"));

    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput,
    });

    expect(result).toEqual({ status: "dispatched", runId: "run_123" });
    expect(deprecationWarnings()).toEqual([]);
  });

  it("never reaches the lookup when the gate is ineligible", async () => {
    enableDefinitionsFor(["trigger_pr_ready"]);

    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput: { ...workflowInput, headRef: "feature/manual" },
    });

    expect(result).toEqual({ status: "ignored", reason: "not_bot_branch" });
    expect(mockGetEnabledDefinition).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });
});
