import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findWorkflowOwnedPullRequestIdentity: vi.fn(),
  publishRunOwnedPrReview: vi.fn(),
}));

vi.mock("../../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../../db/queries/workflow-owned-branches.js", () => ({
  findWorkflowOwnedPullRequestIdentity: (...args: unknown[]) =>
    mocks.findWorkflowOwnedPullRequestIdentity(...args),
}));
vi.mock("../pr-external-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pr-external-resources.js")>()),
  publishRunOwnedPrReview: (...args: unknown[]) =>
    mocks.publishRunOwnedPrReview(...args),
}));
import type { WorkflowOwnedBranchRecord } from "../../db/queries/workflow-owned-branches.js";
import { makePrPayload } from "./test-support.js";
import {
  postPrReviewStep,
  reviewPrAtWorkflowPublishedHead,
} from "./post-pr-review.js";

const owned: WorkflowOwnedBranchRecord = {
  ticketKey: "AWP-26",
  provider: "github",
  repoPath: "acme/app",
  branchName: "ai-workflow/awp-26",
  publishedHeadSha: "fixed-head",
  targetBranch: "main",
  pr: {
    id: 318,
    url: "https://github.com/acme/app/pull/318",
    branch: "ai-workflow/awp-26",
  },
};

const pr = makePrPayload({
  repoPath: "acme/app",
  prNumber: 318,
  prUrl: "https://github.com/acme/app/pull/318",
  headRef: "ai-workflow/awp-26",
  headSha: "trigger-head",
  baseRef: "main",
});

describe("reviewPrAtWorkflowPublishedHead", () => {
  it("reviews the exact head published by the active ticket workflow", () => {
    expect(
      reviewPrAtWorkflowPublishedHead({
        subjectKey: "pr:github:acme/app#318",
        pr,
        owned,
      }).headSha,
    ).toBe("fixed-head");
  });

  it.each([
    ["another pull request owns the run", { subjectKey: "pr:github:acme/app#319" }],
    ["the ticket subject owns the run", { subjectKey: "ticket:jira:AWP-26" }],
    ["the repository differs", { owned: { ...owned, repoPath: "acme/api" } }],
    ["the pull request differs", { owned: { ...owned, pr: { ...owned.pr!, id: 319 } } }],
    ["the branch differs", { owned: { ...owned, branchName: "other" } }],
    ["the target differs", { owned: { ...owned, targetBranch: "release" } }],
    ["there is no published head", { owned: { ...owned, publishedHeadSha: undefined } }],
  ])("keeps the trigger head when %s", (_name, overrides) => {
    expect(
      reviewPrAtWorkflowPublishedHead({
        subjectKey: "pr:github:acme/app#318",
        pr,
        owned,
        ...overrides,
      }).headSha,
    ).toBe("trigger-head");
  });
});

describe("postPrReviewStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findWorkflowOwnedPullRequestIdentity.mockResolvedValue(owned);
    mocks.publishRunOwnedPrReview.mockResolvedValue({
      decision: "approve",
      summary: "Approved",
      inlineCommentCount: 0,
      summaryFallbackCount: 0,
    });
  });

  it("publishes the final review against the head pushed by its fix loop", async () => {
    const result = await postPrReviewStep({
      owner: {
        subjectKey: "pr:github:acme/app#318",
        ownerToken: "owner:autofix",
        runId: "run-autofix",
      },
      pr,
      nodeId: "post-review-approved",
      attempt: 1,
      activationScope: "retry:1",
      reviewResults: [{ decision: "approve", findings: [] }],
    });

    expect(result.decision).toBe("approve");
    expect(mocks.publishRunOwnedPrReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ headSha: "fixed-head" }),
      }),
    );
  });
});
