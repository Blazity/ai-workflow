import { describe, expect, it, vi } from "vitest";
import type { ManualDispatchPullRequestSnapshot } from "../adapters/vcs/types.js";
import type { PrTriggerPayload } from "../workflows/agent-input.js";

vi.mock("../../env.js", () => ({
  env: {},
  getConfiguredVcsProviders: () => [
    {
      kind: "github",
      host: "https://github.com",
      auth: {},
      legacyBaseBranch: "main",
    },
    {
      kind: "gitlab",
      host: "https://gitlab.example.com",
      token: "token",
      legacyBaseBranch: "main",
    },
  ],
  getVcsBotLogin: () => "workflow-bot",
}));

const { parsePullRequestUrl, selectManualTriggerEvent } = await import(
  "./resolve.js"
);

const pr: PrTriggerPayload = {
  provider: "github",
  repoPath: "acme/api",
  prNumber: 42,
  prUrl: "https://github.com/acme/api/pull/42",
  headRef: "feature/manual",
  headSha: "head-sha",
  baseRef: "main",
  title: "Manual dispatch",
  author: "alice",
  isDraft: false,
};

function snapshot(
  overrides: Partial<ManualDispatchPullRequestSnapshot> = {},
): ManualDispatchPullRequestSnapshot {
  return {
    prNumber: 42,
    prUrl: pr.prUrl,
    headRef: pr.headRef,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    title: pr.title,
    author: pr.author,
    isDraft: false,
    state: "open",
    failedChecks: [],
    reviews: [],
    ...overrides,
  };
}

describe("manual pull request input", () => {
  it("parses only configured GitHub and nested GitLab MR URLs", () => {
    expect(parsePullRequestUrl("https://github.com/acme/api/pull/42")).toEqual({
      provider: "github",
      repoPath: "acme/api",
      prNumber: 42,
    });
    expect(
      parsePullRequestUrl(
        "https://gitlab.example.com/platform/services/api/-/merge_requests/17",
      ),
    ).toEqual({
      provider: "gitlab",
      repoPath: "platform/services/api",
      prNumber: 17,
    });
  });

  it.each([
    "https://example.com/acme/api/pull/42",
    "https://github.com/acme/api/issues/42",
    "https://gitlab.example.com/platform/api/merge_requests/17",
  ])("rejects unsupported provider input %s", (url) => {
    expect(() => parsePullRequestUrl(url)).toThrow();
  });

  it("requires created and merged triggers to match current lifecycle state", () => {
    expect(
      selectManualTriggerEvent(
        "trigger_pr_created",
        pr,
        snapshot({ state: "open" }),
        {},
      ),
    ).not.toBeNull();
    expect(
      selectManualTriggerEvent(
        "trigger_pr_created",
        pr,
        snapshot({ state: "closed" }),
        {},
      ),
    ).toBeNull();
    expect(
      selectManualTriggerEvent(
        "trigger_pr_merged",
        pr,
        snapshot({ state: "merged" }),
        {},
      ),
    ).not.toBeNull();
  });

  it("requires a configured current non-gate GitHub check failure", () => {
    const failed = snapshot({
      failedChecks: [
        {
          name: "ci / build",
          conclusion: "failure",
          checkRunId: 100,
          appSlug: "github-actions",
        },
      ],
    });
    expect(
      selectManualTriggerEvent("trigger_pr_checks_failed", pr, failed, {
        checkNames: ["ci / build"],
        githubAppSlugs: ["github-actions"],
      })?.pr.failedChecks,
    ).toEqual(failed.failedChecks);
    expect(
      selectManualTriggerEvent("trigger_pr_checks_failed", pr, failed, {
        checkNames: ["ci / lint"],
        githubAppSlugs: ["github-actions"],
      }),
    ).toBeNull();
  });

  it("uses the latest eligible non-bot review matching configured states", () => {
    const reviews = snapshot({
      reviews: [
        {
          state: "changes_requested",
          author: "human-reviewer",
          body: "Cover the retry path.",
        },
        {
          state: "changes_requested",
          author: "workflow-bot",
          body: "Automated review.",
        },
      ],
    });
    expect(
      selectManualTriggerEvent("trigger_pr_review", pr, reviews, {
        on: ["changes_requested"],
      })?.pr.review,
    ).toEqual({
      state: "changes_requested",
      author: "human-reviewer",
      body: "Cover the retry path.",
    });
  });
});
