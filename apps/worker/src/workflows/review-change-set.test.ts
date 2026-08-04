import { describe, expect, it, vi } from "vitest";
import type { PRFile } from "../adapters/vcs/types.js";
import { assembleReviewContext } from "../sandbox/context.js";
import type { AgentWorkflowInput } from "./agent-input.js";
import {
  assembleReviewChangeSetAddition,
  pullRequestChangeSetTarget,
  renderPullRequestChangeSet,
  type PullRequestChangeSetTarget,
} from "./review-change-set.js";

const { mockCreateRepositoryVCS } = vi.hoisted(() => ({
  mockCreateRepositoryVCS: vi.fn(),
}));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: mockCreateRepositoryVCS,
}));

const target: PullRequestChangeSetTarget = {
  provider: "github",
  repoPath: "acme/app",
  prNumber: 7,
  prUrl: "https://github.com/acme/app/pull/7",
  headRef: "feature/login",
  headSha: "abc1234",
  baseRef: "main",
};

function prEntry(): AgentWorkflowInput {
  return {
    kind: "pr_trigger",
    triggerType: "trigger_pr_ready",
    subjectKey: "pr:github:acme/app#7",
    ownerToken: "owner",
    definitionId: 1,
    definitionVersion: 1,
    scope: "workflow_owned",
    pr: {
      provider: "github",
      repoPath: "acme/app",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      headRef: "feature/login",
      headSha: "abc1234",
      baseRef: "main",
      title: "Add login",
      author: "alice",
      isDraft: false,
    },
  };
}

function reviewContextWith(additions: ReturnType<typeof renderPullRequestChangeSet>[]): string {
  return assembleReviewContext({
    ticket: {
      identifier: "pr:github:acme/app#7",
      title: "Add login",
      description: "Pull request: https://github.com/acme/app/pull/7",
      acceptanceCriteria: "Review the pull request without ticket or branch mutations.",
      comments: [],
    },
    prompt: "You are a review agent...",
    researchPlanMarkdown: "",
    preSandboxAdditions: additions,
  });
}

describe("review change set", () => {
  it("puts the pull request identity, changed files and diff into the review context", () => {
    const files: PRFile[] = [
      {
        path: "src/login.ts",
        additions: 2,
        deletions: 1,
        changeType: "modified",
        patch: "@@ -3,2 +3,3 @@\n context\n-old\n+new\n+extra",
      },
      {
        path: "assets/logo.png",
        additions: 0,
        deletions: 0,
        changeType: "added",
      },
    ];

    const context = reviewContextWith([
      renderPullRequestChangeSet(target, { ok: true, files }),
    ]);

    expect(context).toContain("## Pre-Sandbox: Pull request change set");
    expect(context).toContain("- Provider: github");
    expect(context).toContain("- Repository: acme/app");
    expect(context).toContain("- Pull request: #7");
    expect(context).toContain("- URL: https://github.com/acme/app/pull/7");
    expect(context).toContain("- Head: feature/login at abc1234");
    expect(context).toContain("- Base: main");
    expect(context).toContain("### Changed files (2)");
    expect(context).toContain("- `src/login.ts` modified +2 -1");
    expect(context).toContain("- `assets/logo.png` added +0 -0");
    expect(context).toContain("#### src/login.ts");
    expect(context).toContain("@@ -3,2 +3,3 @@\n context\n-old\n+new\n+extra");
    expect(context).toContain("No textual diff available for this file");
    expect(context).not.toContain("[TRUNCATED]");
  });

  it("announces every truncation it applies in the rendered text", () => {
    const files: PRFile[] = [
      // One file whose diff alone exceeds the per-file cap.
      {
        path: "src/huge.ts",
        additions: 9000,
        deletions: 0,
        changeType: "modified",
        patch: `@@ -1,1 +1,9000 @@\n${"+line\n".repeat(9000)}`,
      },
      // Then enough further files to exhaust the total diff budget and the
      // listing cap.
      ...Array.from({ length: 250 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        additions: 1,
        deletions: 0,
        changeType: "modified" as const,
        patch: `@@ -1,1 +1,2 @@\n${"+padding\n".repeat(2000)}`,
      })),
    ];

    const context = reviewContextWith([
      renderPullRequestChangeSet(target, { ok: true, files }),
    ]);

    expect(context).toContain("### Changed files (251, first 200 listed)");
    expect(context).toContain(
      "[TRUNCATED] 51 further changed files are not listed, to fit the prompt budget.",
    );
    expect(context).toContain(
      "[TRUNCATED] The diff for src/huge.ts is cut off after 20000 characters",
    );
    expect(context).toContain(
      "[TRUNCATED] The diffs for 247 further changed files are omitted",
    );
    expect(context).toContain(
      "do not treat a file you cannot see here as unchanged",
    );
    // The total patch ledger closes exactly on its 60000 character cap: 20000
    // for the capped file, two whole 18016 character patches, and the 3968 that
    // remain for the fourth before every later file is dropped. 196 dropped
    // here plus the 51 that were never listed are the 247 reported above.
    expect(context).toContain(
      "[TRUNCATED] The diff for src/file-2.ts is cut off after 3968 characters",
    );
    expect(context.match(/^#### /gm)).toHaveLength(4);
  });

  it("reports an empty change set as nothing changed, not as unavailable", () => {
    const context = reviewContextWith([
      renderPullRequestChangeSet(target, { ok: true, files: [] }),
    ]);

    expect(context).toContain(
      "The provider reported no changed files for this pull request.",
    );
    expect(context).not.toContain("could not be fetched from the provider");
    expect(context).not.toContain("The diff is unavailable for this review.");
  });

  it("bounds the provider error text it puts into the prompt", async () => {
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      listPRFiles: vi
        .fn()
        .mockRejectedValue(new Error(`502 ${"body ".repeat(1000)}`)),
    });

    const addition = await assembleReviewChangeSetAddition(target);

    expect(addition.content).toContain(
      "The change set could not be fetched from the provider: 502 ",
    );
    expect(addition.content.length).toBeLessThan(1500);
  });

  it("degrades to a stated diff-unavailable addition when the provider fails", async () => {
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      listPRFiles: vi.fn().mockRejectedValue(new Error("provider returned 502")),
    });

    const addition = await assembleReviewChangeSetAddition(target);
    const context = reviewContextWith([addition]);

    expect(context).toContain("## Pre-Sandbox: Pull request change set");
    expect(context).toContain(
      "The change set could not be fetched from the provider: provider returned 502.",
    );
    expect(context).toContain("The diff is unavailable for this review.");
    expect(context).toContain("Do not report that nothing changed.");
    expect(context).toContain("- Pull request: #7");
  });

  it("states the gap when the provider cannot list pull request files at all", async () => {
    mockCreateRepositoryVCS.mockReset().mockReturnValue({});

    const addition = await assembleReviewChangeSetAddition(target);

    expect(addition.content).toContain(
      "The change set could not be fetched from the provider: github cannot list pull request files.",
    );
  });

  it("fetches the change set for a pull request run", async () => {
    const listPRFiles = vi.fn().mockResolvedValue([
      {
        path: "src/login.ts",
        additions: 1,
        deletions: 0,
        changeType: "modified",
        patch: "@@ -1,1 +1,2 @@\n+new",
      },
    ]);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({ listPRFiles });

    const addition = await assembleReviewChangeSetAddition(
      pullRequestChangeSetTarget(prEntry())!,
    );

    expect(mockCreateRepositoryVCS).toHaveBeenCalledWith({
      provider: "github",
      repoPath: "acme/app",
      baseBranch: "main",
    });
    expect(listPRFiles).toHaveBeenCalledWith(7);
    expect(addition.target).toEqual(["review"]);
    expect(addition.content).toContain("- `src/login.ts` modified +1 -0");
  });

  it("leaves non-PR runs without a change set target or review addition", () => {
    const ticketEntry: AgentWorkflowInput = {
      kind: "ticket",
      subjectKey: "AWT-1",
      ticketKey: "AWT-1",
      ownerToken: "owner",
    };
    const planApprovedEntry: AgentWorkflowInput = {
      kind: "plan_approved",
      subjectKey: "AWT-1",
      ticketKey: "AWT-1",
      ownerToken: "owner",
      definitionId: 1,
      approvedPlan: { markdown: "# Plan" },
      approval: {
        approvalRequestId: "req-1",
        approver: "alice",
        approvedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    expect(pullRequestChangeSetTarget(ticketEntry)).toBeNull();
    expect(pullRequestChangeSetTarget(planApprovedEntry)).toBeNull();
    expect(pullRequestChangeSetTarget(prEntry())).toEqual(target);

    const ticketContext = assembleReviewContext({
      ticket: {
        identifier: "AWT-1",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "You are a review agent...",
      researchPlanMarkdown: "# Plan",
      preSandboxAdditions: [],
    });
    expect(ticketContext).not.toContain("## Pre-Sandbox");
    expect(ticketContext).not.toContain("Pull request change set");
  });
});
