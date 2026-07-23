import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: {
    postPrGate: {
      runOn: {
        botPrsOnly: true,
        draftPrs: false,
        baseBranches: ["main"],
      },
      steps: [],
    },
  },
}));

const mockAcquireLock = vi.fn();
const mockGetDedupe = vi.fn();
const mockGetCurrent = vi.fn();
const mockSetCurrent = vi.fn();
const mockClaimRun = vi.fn();
const mockUpdateRunIdIfHeadSha = vi.fn();
const mockReleaseLock = vi.fn();
const mockStart = vi.fn();
const mockGetRun = vi.fn();
const mockCancelRun = vi.fn();
const mockCreateAdapters = vi.fn();
const mockUpdateGateStatus = vi.fn();

vi.mock("workflow/api", () => ({
  start: (...args: any[]) => mockStart(...args),
  getRun: (...args: any[]) => mockGetRun(...args),
}));

vi.mock("../db/client.js", () => ({
  getDb: vi.fn(() => "db"),
}));

vi.mock("../post-pr-gate/config.js", () => ({
  loadPostPrGateConfig: vi.fn(() => state.config),
}));

vi.mock("../workflow-definition/store.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: vi.fn().mockResolvedValue(null),
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
  createAdapters: (...args: any[]) => mockCreateAdapters(...args),
}));

vi.mock("../workflows/post-pr-gate.js", () => ({
  postPrGateWorkflow: vi.fn(),
}));

const { dispatchPostPrGateWebhook } = await import("./post-pr-gate-dispatch.js");

const workflowInput = {
  prNumber: 42,
  headSha: "sha1",
  headRef: "ai-workflow/AIW-32",
  baseRef: "main",
  title: "AIW-32",
  body: "",
  author: "alice",
  isDraft: false,
  url: "https://gitlab.com/group/demo/-/merge_requests/42",
  ownerRepo: "group/demo",
  provider: "gitlab" as const,
};

describe("dispatchPostPrGateWebhook eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.config = {
      postPrGate: {
        runOn: {
          botPrsOnly: true,
          draftPrs: false,
          baseBranches: ["main"],
        },
        steps: [],
      },
    };
    mockAcquireLock.mockResolvedValue("lock-token");
    mockGetCurrent.mockResolvedValue(null);
    mockGetDedupe.mockResolvedValue(null);
    mockStart.mockResolvedValue({ runId: "run_123" });
    mockClaimRun.mockResolvedValue(null);
    mockUpdateRunIdIfHeadSha.mockResolvedValue(true);
    mockCancelRun.mockResolvedValue(undefined);
    mockGetRun.mockReturnValue({ cancel: mockCancelRun });
    mockUpdateGateStatus.mockResolvedValue(undefined);
    mockCreateAdapters.mockReturnValue({
      vcs: {
        createGateStatus: vi.fn(),
        updateGateStatus: mockUpdateGateStatus,
      },
    });
  });

  it("skips non-bot branches before locking or dedupe", async () => {
    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput: { ...workflowInput, headRef: "feature/manual" },
    });

    expect(result).toEqual({ status: "ignored", reason: "not_bot_branch" });
    expectNoGateMutation();
  });

  it("continues to accept a legacy managed branch", async () => {
    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput: {
        ...workflowInput,
        headRef: "blazebot/AIW-32",
      },
    });

    expect(result).toEqual({ status: "dispatched", runId: "run_123" });
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("skips draft pull requests before locking or dedupe", async () => {
    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput: { ...workflowInput, isDraft: true },
    });

    expect(result).toEqual({ status: "ignored", reason: "draft" });
    expectNoGateMutation();
  });

  it("skips unconfigured base branches before locking or dedupe", async () => {
    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput: { ...workflowInput, baseRef: "release" },
    });

    expect(result).toEqual({ status: "ignored", reason: "base_branch" });
    expectNoGateMutation();
  });
});

describe("dispatchPostPrGateWebhook orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue("lock-token");
    mockGetCurrent.mockResolvedValue(null);
    mockGetDedupe.mockResolvedValue(null);
    mockStart.mockResolvedValue({ runId: "run_123" });
    mockClaimRun.mockResolvedValue(null);
    mockUpdateRunIdIfHeadSha.mockResolvedValue(true);
    mockCancelRun.mockResolvedValue(undefined);
    mockGetRun.mockReturnValue({ cancel: mockCancelRun });
    mockUpdateGateStatus.mockResolvedValue(undefined);
    mockCreateAdapters.mockReturnValue({
      vcs: {
        createGateStatus: vi.fn(),
        updateGateStatus: mockUpdateGateStatus,
      },
    });
  });

  it("dispatches an eligible webhook and records the run", async () => {
    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput,
    });

    expect(result).toEqual({ status: "dispatched", runId: "run_123" });
    expect(mockSetCurrent).toHaveBeenCalledWith("group/demo", 42, {
      runId: "",
      headSha: "sha1",
      gateStatusRefs: [],
    });
    expect(mockStart).toHaveBeenCalledWith(expect.any(Function), [workflowInput]);
    expect(mockClaimRun).toHaveBeenCalledWith("group/demo", 42, "sha1", "run_123");
    expect(mockUpdateRunIdIfHeadSha).toHaveBeenCalledWith(
      "group/demo",
      42,
      "sha1",
      "run_123",
    );
    expect(mockReleaseLock).toHaveBeenCalledWith("group/demo", 42, "lock-token");
  });

  it("skips when another webhook owns the lock", async () => {
    mockAcquireLock.mockResolvedValueOnce(null);

    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput,
    });

    expect(result).toEqual({ status: "ignored", reason: "lock_busy" });
    expect(mockGetDedupe).not.toHaveBeenCalled();
    expect(mockSetCurrent).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockClaimRun).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it("skips when the head SHA is already claimed", async () => {
    mockGetDedupe.mockResolvedValueOnce("run_existing");

    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput,
    });

    expect(result).toEqual({
      status: "ignored",
      reason: "already_claimed",
      runId: "run_existing",
    });
    expect(mockSetCurrent).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockClaimRun).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledWith("group/demo", 42, "lock-token");
  });

  it("cancels the previous SHA run before starting the replacement", async () => {
    const previousRef = {
      provider: "gitlab" as const,
      name: "blazebot / code-hygiene",
      headSha: "sha0",
    };
    mockGetCurrent.mockResolvedValueOnce({
      runId: "run_old",
      headSha: "sha0",
      gateStatusRefs: [previousRef],
    });

    const result = await dispatchPostPrGateWebhook({
      action: "update",
      workflowInput,
    });

    expect(result).toEqual({ status: "dispatched", runId: "run_123" });
    expect(mockGetRun).toHaveBeenCalledWith("run_old");
    expect(mockCancelRun).toHaveBeenCalled();
    expect(mockUpdateGateStatus).toHaveBeenCalledWith(previousRef, {
      status: "completed",
      conclusion: "cancelled",
      summary: "Cancelled - newer commit replaces this gate run.",
    });
    expect(mockSetCurrent).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  it("cancels the started workflow when claimRun loses the race", async () => {
    mockClaimRun.mockResolvedValueOnce("run_winner");

    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput,
    });

    expect(result).toEqual({
      status: "ignored",
      reason: "already_claimed",
      runId: "run_winner",
    });
    expect(mockGetRun).toHaveBeenCalledWith("run_123");
    expect(mockCancelRun).toHaveBeenCalled();
    expect(mockUpdateRunIdIfHeadSha).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledWith("group/demo", 42, "lock-token");
  });
});

function expectNoGateMutation(): void {
  expect(mockAcquireLock).not.toHaveBeenCalled();
  expect(mockGetDedupe).not.toHaveBeenCalled();
  expect(mockGetCurrent).not.toHaveBeenCalled();
  expect(mockSetCurrent).not.toHaveBeenCalled();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockClaimRun).not.toHaveBeenCalled();
  expect(mockUpdateRunIdIfHeadSha).not.toHaveBeenCalled();
  expect(mockReleaseLock).not.toHaveBeenCalled();
}
