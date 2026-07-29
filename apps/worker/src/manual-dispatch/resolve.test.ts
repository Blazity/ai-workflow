import { beforeEach, describe, expect, it, vi } from "vitest";
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

const mocks = vi.hoisted(() => ({
  getDeployedWorkflowDefinitionVersion: vi.fn(),
  getManualDispatchPullRequest: vi.fn(),
  isConfiguredTriggerRepository: vi.fn(),
  findWorkflowOwnedPullRequest: vi.fn(),
  hasDispatchBlockingApprovalForTicket: vi.fn(),
}));

vi.mock("../workflow-definition/store.js", () => ({
  getDeployedWorkflowDefinitionVersion: mocks.getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinitionVersion: vi.fn(),
}));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: () => ({
    getManualDispatchPullRequest: mocks.getManualDispatchPullRequest,
  }),
}));
// Only the provider-reachability probe is stubbed; the trigger-eligibility
// helpers this module shares with automatic dispatch stay real.
vi.mock("../lib/dispatch-trigger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/dispatch-trigger.js")>()),
  isConfiguredTriggerRepository: mocks.isConfiguredTriggerRepository,
}));
vi.mock("../db/queries/workflow-owned-branches.js", () => ({
  findWorkflowOwnedPullRequest: mocks.findWorkflowOwnedPullRequest,
}));
vi.mock("../approvals/store.js", () => ({
  hasDispatchBlockingApprovalForTicket: mocks.hasDispatchBlockingApprovalForTicket,
}));
vi.mock("../post-pr-gate/config.js", () => ({
  loadPostPrGateConfig: () => ({ postPrGate: { steps: [] } }),
}));

const { parsePullRequestUrl, resolveManualDispatch, selectManualTriggerEvent } =
  await import("./resolve.js");

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

describe("manual dispatch against a definition repository pin", () => {
  const definitionDb = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ name: "PR flow" }] }),
      }),
    }),
  } as unknown as Parameters<typeof resolveManualDispatch>[0]["db"];

  const issueTracker = {
    fetchTicket: vi.fn().mockResolvedValue({ identifier: "AIW-1" }),
  } as unknown as Parameters<typeof resolveManualDispatch>[0]["issueTracker"];

  function deployed(
    scope: "any" | "workflow_owned",
    repositoryScope: Record<string, unknown>,
  ) {
    return {
      definitionId: 5,
      version: 12,
      definition: {
        schemaVersion: 1,
        repositoryScope,
        nodes: [
          {
            id: "trigger",
            type: "trigger_pr_created",
            x: 0,
            y: 0,
            params: { scope },
            inputs: {},
          },
        ],
        edges: [],
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getManualDispatchPullRequest.mockResolvedValue(snapshot());
    mocks.isConfiguredTriggerRepository.mockResolvedValue(true);
    mocks.hasDispatchBlockingApprovalForTicket.mockResolvedValue(false);
    mocks.findWorkflowOwnedPullRequest.mockResolvedValue({ ticketKey: "AIW-1" });
  });

  it("rejects an any-scope pull request outside the pin", async () => {
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", { repositories: [{ provider: "github", repoPath: "acme/other" }] }),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
      }),
    ).rejects.toThrow("outside the repositories pinned to this workflow");
  });

  it("accepts an any-scope pull request inside the pin, matching case-insensitively", async () => {
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", { repositories: [{ provider: "github", repoPath: "Acme/API" }] }),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
      }),
    ).resolves.toMatchObject({
      inputPayload: { scope: "any", pr: expect.objectContaining({ repoPath: "acme/api" }) },
    });
  });

  it("lets an exact definition pin extend the global allowlist", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "acme/other";
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", {
        repositories: [{ provider: "github", repoPath: "Acme/API" }],
      }),
    );

    try {
      await expect(
        resolveManualDispatch({
          db: definitionDb,
          issueTracker,
          definitionId: 5,
          triggerNodeId: "trigger",
          dispatchInput: { kind: "pull_request", url: pr.prUrl },
        }),
      ).resolves.toMatchObject({
        inputPayload: { scope: "any", pr: expect.objectContaining({ repoPath: "acme/api" }) },
      });
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
  });

  it("does not let provider-only scope extend the global allowlist", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "acme/other";
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", { providers: ["github"] }),
    );

    try {
      await expect(
        resolveManualDispatch({
          db: definitionDb,
          issueTracker,
          definitionId: 5,
          triggerNodeId: "trigger",
          dispatchInput: { kind: "pull_request", url: pr.prUrl },
        }),
      ).rejects.toThrow("outside the configured allowlist");
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
  });

  it("still accepts a workflow-owned pull request outside the pin", async () => {
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("workflow_owned", {
        repositories: [{ provider: "github", repoPath: "acme/other" }],
      }),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-1" });
  });
});
