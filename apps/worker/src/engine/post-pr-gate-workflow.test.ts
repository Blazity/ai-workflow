import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The legacy post-PR gate on a deployment with no usable issue tracker.
 *
 * The gate creates a pending status per step on the PR head before it runs
 * anything, and it has no retries. A tracker read that threw after that point
 * left every status pending on the PR, and a branch rule requiring the gate
 * then blocked the merge with nothing running to ever complete it. The gate is
 * about the pull request, so it runs to the end either way.
 */
const state = vi.hoisted(() => ({
  tracker: "not_connected" as "not_connected" | "unreadable",
  createGateStatus: vi.fn(),
  updateGateStatus: vi.fn(),
  handler: vi.fn(),
}));

vi.mock("./support/adapters.js", async () => {
  const { adaptersFor } = await import("../test-support/issue-tracker.js");
  return { createAdapters: async () => adaptersFor(state.tracker) };
});
vi.mock("./support/vcs-runtime.js", () => ({
  resolveRepositoryVCS: async () => ({
    createGateStatus: state.createGateStatus,
    updateGateStatus: state.updateGateStatus,
  }),
}));
vi.mock("../post-pr-gate/config.js", () => ({
  loadPostPrGateConfig: () => ({
    postPrGate: {
      runOn: { botPrsOnly: true, draftPrs: false, baseBranches: [] },
      steps: [{ uses: "code-hygiene", onFailure: "continue" }],
    },
  }),
}));
vi.mock("../post-pr-gate/steps/index.js", () => ({
  postPrGateStepRegistry: { "code-hygiene": state.handler },
}));
vi.mock("../post-pr-gate/gate-store.js", () => ({
  GateStore: class {
    appendGateStatusRefsForSha = async () => true;
  },
}));
vi.mock("../infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { postPrGateWorkflow } = await import("./post-pr-gate-workflow.js");

const input = {
  prNumber: 42,
  headSha: "sha-head",
  headRef: "ai-workflow/aiw-32",
  baseRef: "main",
  title: "AIW-32",
  body: "",
  author: "ai-workflow[bot]",
  isDraft: false,
  url: "https://github.com/acme/api/pull/42",
  ownerRepo: "acme/api",
  provider: "github" as const,
};

describe("post-PR gate without an issue tracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.createGateStatus.mockImplementation(async (name: string) => ({ name }));
    state.handler.mockResolvedValue({ conclusion: "success", summary: "clean" });
  });

  it.each(["not_connected", "unreadable"] as const)(
    "completes every status it created when the tracker is %s",
    async (tracker) => {
      state.tracker = tracker;

      await expect(postPrGateWorkflow(input)).resolves.toEqual({ ranSteps: 1, failed: false });

      expect(state.createGateStatus).toHaveBeenCalledTimes(1);
      expect(state.updateGateStatus).toHaveBeenCalledTimes(1);
      expect(state.updateGateStatus.mock.calls[0]![1]).toMatchObject({
        status: "completed",
        conclusion: "success",
      });
      // The step ran on the pull request alone: no ticket, no tracker handed in.
      const context = state.handler.mock.calls[0]![0].context;
      expect(context.ticket).toBeNull();
      expect(context.adapters).not.toHaveProperty("issueTracker");
    },
  );
});
