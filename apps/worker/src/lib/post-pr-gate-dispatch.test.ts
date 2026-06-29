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
const mockSetCurrent = vi.fn();
const mockClaimRun = vi.fn();
const mockReleaseLock = vi.fn();
const mockStart = vi.fn();

vi.mock("workflow/api", () => ({
  start: (...args: any[]) => mockStart(...args),
  getRun: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  getDb: vi.fn(() => "db"),
}));

vi.mock("../post-pr-gate/config.js", () => ({
  loadPostPrGateConfig: vi.fn(() => state.config),
}));

vi.mock("../post-pr-gate/gate-store.js", () => ({
  GateStore: vi.fn(() => ({
    acquireLock: mockAcquireLock,
    getCurrent: vi.fn(),
    getDedupe: mockGetDedupe,
    setCurrent: mockSetCurrent,
    claimRun: mockClaimRun,
    updateRunIdIfHeadSha: vi.fn(),
    releaseLock: mockReleaseLock,
  })),
}));

vi.mock("./adapters.js", () => ({
  createAdapters: vi.fn(),
}));

const { dispatchPostPrGateWebhook } = await import("./post-pr-gate-dispatch.js");

const workflowInput = {
  prNumber: 42,
  headSha: "sha1",
  headRef: "blazebot/AIW-32",
  baseRef: "main",
  title: "AIW-32",
  body: "",
  author: "alice",
  isDraft: false,
  url: "https://gitlab.com/group/demo/-/merge_requests/42",
  ownerRepo: "group/demo",
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
    mockGetDedupe.mockResolvedValue(null);
    mockStart.mockResolvedValue({ runId: "run_123" });
    mockClaimRun.mockResolvedValue(null);
  });

  it("skips non-bot branches before locking or dedupe", async () => {
    const result = await dispatchPostPrGateWebhook({
      action: "opened",
      workflowInput: { ...workflowInput, headRef: "feature/manual" },
    });

    expect(result).toEqual({ status: "ignored", reason: "not_bot_branch" });
    expectNoGateMutation();
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

function expectNoGateMutation(): void {
  expect(mockAcquireLock).not.toHaveBeenCalled();
  expect(mockGetDedupe).not.toHaveBeenCalled();
  expect(mockSetCurrent).not.toHaveBeenCalled();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockClaimRun).not.toHaveBeenCalled();
  expect(mockReleaseLock).not.toHaveBeenCalled();
}
