import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRepositoryVCS: vi.fn(),
  getDb: vi.fn(),
  listWorkflowOwnedBranchesForTicket: vi.fn(),
  findRunPrSiblings: vi.fn(),
  listRepositories: vi.fn(),
  warn: vi.fn(),
  env: { REVIEW_LEDGER_ENABLED: false },
}));

vi.mock("../../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: mocks.createRepositoryVCS,
}));

vi.mock("../../db/client.js", () => ({ getDb: mocks.getDb }));

vi.mock("../../db/queries/workflow-owned-branches.js", () => ({
  listWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
}));

vi.mock("../../db/queries/run-pr-siblings.js", () => ({
  findRunPrSiblings: mocks.findRunPrSiblings,
}));

vi.mock("../../adapters/vcs/repository-directory.js", () => ({
  createRepositoryDirectoryForProviders: () => ({
    listRepositories: mocks.listRepositories,
  }),
}));

vi.mock("../../../env.js", () => ({
  getConfiguredVcsProviders: () => [{ kind: "github" }, { kind: "gitlab" }],
  env: mocks.env,
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: mocks.warn },
}));

import type { ReviewThread, ReviewThreadFeed } from "../../adapters/vcs/types.js";
import type { WorkspaceRepositoryInput } from "../../sandbox/repo-workspace.js";
import {
  blockPrTriggerRepositoriesWithSiblingsStep,
  execute,
  paramsSchema,
} from "./fetch-pr-context.js";
import {
  makeCtx,
  makeNode,
  makePrPayload,
  runControlErrorCases,
} from "./test-support.js";

const repoWithPr: WorkspaceRepositoryInput = {
  provider: "github",
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "selected",
  workflowOwnedBranch: {
    branchName: "blazebot/awt-1",
    pr: { id: 7, url: "https://pr/7", branch: "blazebot/awt-1" },
  },
};

const originalAllowedRepos = process.env.AGENT_ALLOWED_REPOS;

afterEach(() => {
  if (originalAllowedRepos === undefined) delete process.env.AGENT_ALLOWED_REPOS;
  else process.env.AGENT_ALLOWED_REPOS = originalAllowedRepos;
});

describe("fetch_pr_context paramsSchema", () => {
  it("accepts only empty params", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("fetch_pr_context execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.env.REVIEW_LEDGER_ENABLED = false;
  });

  it("fetches contexts for selected repositories and keeps the output compact", async () => {
    const prComments = [{ author: "bob", body: "long review body", liked: false }];
    const checkResults = [
      { name: "ci", status: "completed" as const, conclusion: "failure", logs: "log" },
    ];
    mocks.createRepositoryVCS.mockReturnValue({
      getPRComments: vi.fn().mockResolvedValue(prComments),
      getCheckRunResults: vi.fn().mockResolvedValue(checkResults),
      getPRConflictStatus: vi.fn().mockResolvedValue(true),
    });
    const ctx = makeCtx({ selectedRepositories: [repoWithPr] });

    const result = await execute(makeNode("fetch_pr_context"), {}, ctx);

    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        contexts: [
          {
            repository: "github:acme/api",
            prCommentCount: 1,
            checkResults: [{ name: "ci", conclusion: "failure" }],
            hasConflicts: true,
          },
        ],
      },
    });
    expect(ctx.repositoryContexts).toEqual([
      { repository: repoWithPr, prComments, checkResults, hasConflicts: true },
    ]);
  });

  it("returns an empty context for repositories without a workflow-owned PR", async () => {
    const ctx = makeCtx({
      selectedRepositories: [{ ...repoWithPr, workflowOwnedBranch: undefined }],
    });

    const result = await execute(makeNode("fetch_pr_context"), {}, ctx);

    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
    expect(result.kind).toBe("next");
    expect(ctx.repositoryContexts[0]).toMatchObject({
      prComments: [],
      checkResults: [],
      hasConflicts: false,
    });
  });

  it("uses the validated PR event tuple instead of a divergent current intent row", async () => {
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([
      {
        ticketKey: "AWT-1",
        provider: "github",
        repoPath: "acme/api",
        branchName: "feature/new-intent",
        pr: {
          id: 42,
          url: "https://github.com/acme/api/pull/42",
          branch: "feature/old-confirmed",
        },
      },
    ]);
    mocks.createRepositoryVCS.mockReturnValue({
      getPRComments: vi.fn().mockResolvedValue([]),
      getCheckRunResults: vi.fn().mockResolvedValue([]),
      getPRConflictStatus: vi.fn().mockResolvedValue(false),
    });
    const ctx = makeCtx({
      selectedRepositories: [],
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_created",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr: makePrPayload({
          prNumber: 7,
          prUrl: "https://github.com/acme/api/pull/7",
          headRef: "feature/validated-event",
        }),
      },
    });

    const result = await execute(makeNode("fetch_pr_context"), {}, ctx);

    expect(mocks.listWorkflowOwnedBranchesForTicket).not.toHaveBeenCalled();
    expect(mocks.createRepositoryVCS).toHaveBeenCalledWith({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
    });
    expect(result.kind).toBe("next");
    expect(ctx.repositoryContexts[0].repository.workflowOwnedBranch).toEqual({
      branchName: "feature/validated-event",
      pr: {
        id: 7,
        url: "https://github.com/acme/api/pull/7",
        branch: "feature/validated-event",
      },
    });
  });

  it("fails when no repositories are in scope", async () => {
    const result = await execute(makeNode("fetch_pr_context"), {}, makeCtx());
    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("no repositories in scope");
    }
  });

  describe("review ledger feed", () => {
    const thread = (
      overrides: Partial<ReviewThread> & Pick<ReviewThread, "threadId" | "alias">,
    ): ReviewThread => ({
      source: "human",
      resolvable: true,
      awaitingHuman: false,
      notes: [
        {
          author: "alice",
          body: "please add the null check",
          createdAt: "2026-08-20T10:00:00.000Z",
          isLedgerReply: false,
        },
      ],
      ...overrides,
    });

    const feed: ReviewThreadFeed = {
      threads: [
        thread({ threadId: "d-1", alias: "T1", filePath: "src/a.ts", line: 12 }),
        thread({ threadId: "d-2", alias: "T2", source: "bot" }),
        thread({ threadId: "d-3", alias: "T3", source: "third_party" }),
        thread({ threadId: "d-4", alias: "T4", awaitingHuman: true }),
      ],
      truncated: 2,
      contextTruncated: 5,
      snapshotAt: "2026-08-21T09:00:00.000Z",
    };

    const prTriggerCtx = () =>
      makeCtx({
        selectedRepositories: [],
        entry: {
          kind: "pr_trigger",
          triggerType: "trigger_pr_review",
          subjectKey: "ticket:jira:AWT-1",
          ticketKey: "AWT-1",
          ownerToken: "owner:test",
          definitionId: 1,
          definitionVersion: 1,
          scope: "workflow_owned",
          pr: makePrPayload(),
        },
      });

    it("loads the feed into the ledger and reports per-source counters", async () => {
      mocks.env.REVIEW_LEDGER_ENABLED = true;
      const listReviewThreads = vi.fn().mockResolvedValue(feed);
      mocks.createRepositoryVCS.mockReturnValue({
        getPRComments: vi.fn().mockResolvedValue([]),
        getCheckRunResults: vi.fn().mockResolvedValue([]),
        getPRConflictStatus: vi.fn().mockResolvedValue(false),
        listReviewThreads,
      });
      const ctx = prTriggerCtx();

      const result = await execute(makeNode("fetch_pr_context"), {}, ctx);

      expect(listReviewThreads).toHaveBeenCalledWith(7);
      expect(ctx.reviewLedger).toEqual({
        feed,
        dispositions: [],
        verification: null,
      });
      expect(result.kind).toBe("next");
      // Work items exclude the third-party thread and the one awaiting a human,
      // so the source counters have to be read off the whole feed to stay
      // informative in the trace.
      expect(result.kind === "next" && result.output?.reviewThreads).toEqual({
        workItems: 2,
        awaitingHuman: 1,
        bySource: { human: 2, bot: 1, third_party: 1 },
        truncated: 2,
        // Two different omissions, so the trace has to carry both: work the next
        // run inherits, and background nobody will ever see.
        contextTruncated: 5,
      });
    });

    it("never reads threads for a run started by failing checks", async () => {
      // A checks-fix run owes the reviewer nothing: its job is to make CI green.
      // Attaching the ledger to it would make the fix agent answer threads it
      // was never prompted about, fail on "no disposition survived", and burn a
      // fix attempt without ever pushing the CI fix.
      mocks.env.REVIEW_LEDGER_ENABLED = true;
      const listReviewThreads = vi.fn();
      mocks.createRepositoryVCS.mockReturnValue({
        getPRComments: vi.fn().mockResolvedValue([]),
        getCheckRunResults: vi.fn().mockResolvedValue([]),
        getPRConflictStatus: vi.fn().mockResolvedValue(false),
        listReviewThreads,
      });
      const ctx = prTriggerCtx();
      ctx.entry = { ...ctx.entry, triggerType: "trigger_pr_checks_failed" } as typeof ctx.entry;

      const result = await execute(makeNode("fetch_pr_context"), {}, ctx);

      expect(listReviewThreads).not.toHaveBeenCalled();
      expect(ctx.reviewLedger).toBeUndefined();
      expect(result.kind === "next" && result.output).not.toHaveProperty("reviewThreads");
    });

    it("stays on the pre-ledger path when the PR carries no threads at all", async () => {
      // "Request changes" with a summary and no inline comment leaves an empty
      // feed. An empty ledger would answer that review with a clean no_change
      // and throw the plan away, so the flat comment list keeps the decision.
      mocks.env.REVIEW_LEDGER_ENABLED = true;
      const listReviewThreads = vi.fn().mockResolvedValue({
        threads: [],
        truncated: 0,
        contextTruncated: 0,
        snapshotAt: "2026-08-21T09:00:00.000Z",
      });
      mocks.createRepositoryVCS.mockReturnValue({
        getPRComments: vi.fn().mockResolvedValue([]),
        getCheckRunResults: vi.fn().mockResolvedValue([]),
        getPRConflictStatus: vi.fn().mockResolvedValue(false),
        listReviewThreads,
      });
      const ctx = prTriggerCtx();

      const result = await execute(makeNode("fetch_pr_context"), {}, ctx);

      expect(listReviewThreads).toHaveBeenCalledWith(7);
      expect(ctx.reviewLedger).toBeUndefined();
      expect(result.kind === "next" && result.output).not.toHaveProperty("reviewThreads");
    });

    it("leaves the block untouched when the flag is off", async () => {
      const listReviewThreads = vi.fn();
      mocks.createRepositoryVCS.mockReturnValue({
        getPRComments: vi.fn().mockResolvedValue([]),
        getCheckRunResults: vi.fn().mockResolvedValue([]),
        getPRConflictStatus: vi.fn().mockResolvedValue(false),
        listReviewThreads,
      });
      const ctx = prTriggerCtx();

      const result = await execute(makeNode("fetch_pr_context"), {}, ctx);

      expect(listReviewThreads).not.toHaveBeenCalled();
      expect(ctx.reviewLedger).toBeUndefined();
      expect(result).toEqual({
        kind: "next",
        output: {
          status: "ok",
          contexts: [
            {
              repository: "github:acme/api",
              prCommentCount: 0,
              checkResults: [],
              hasConflicts: false,
            },
          ],
        },
      });
    });

    it("never reads threads for a ticket run, flag or no flag", async () => {
      mocks.env.REVIEW_LEDGER_ENABLED = true;
      const listReviewThreads = vi.fn();
      mocks.createRepositoryVCS.mockReturnValue({
        getPRComments: vi.fn().mockResolvedValue([]),
        getCheckRunResults: vi.fn().mockResolvedValue([]),
        getPRConflictStatus: vi.fn().mockResolvedValue(false),
        listReviewThreads,
      });
      const ctx = makeCtx({ selectedRepositories: [repoWithPr] });

      await execute(makeNode("fetch_pr_context"), {}, ctx);

      expect(listReviewThreads).not.toHaveBeenCalled();
      expect(ctx.reviewLedger).toBeUndefined();
    });

    it("degrades to a run without a ledger when the provider refuses the feed", async () => {
      mocks.env.REVIEW_LEDGER_ENABLED = true;
      const prComments = [{ author: "bob", body: "please fix", liked: false }];
      mocks.createRepositoryVCS.mockReturnValue({
        getPRComments: vi.fn().mockResolvedValue(prComments),
        getCheckRunResults: vi.fn().mockResolvedValue([]),
        getPRConflictStatus: vi.fn().mockResolvedValue(false),
        listReviewThreads: vi.fn().mockRejectedValue(new Error("GraphQL 502")),
      });
      const ctx = prTriggerCtx();

      const result = await execute(makeNode("fetch_pr_context"), {}, ctx);

      expect(result.kind).toBe("next");
      expect(ctx.reviewLedger).toBeUndefined();
      expect(ctx.repositoryContexts[0]!.prComments).toEqual(prComments);
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.objectContaining({ prId: 7 }),
        "review_ledger_feed_unavailable",
      );
    });

    it("still rethrows a run control error raised while reading the feed", async () => {
      mocks.env.REVIEW_LEDGER_ENABLED = true;
      const [, error] = runControlErrorCases()[0]!;
      mocks.createRepositoryVCS.mockReturnValue({
        getPRComments: vi.fn().mockResolvedValue([]),
        getCheckRunResults: vi.fn().mockResolvedValue([]),
        getPRConflictStatus: vi.fn().mockResolvedValue(false),
        listReviewThreads: vi.fn().mockRejectedValue(error),
      });

      await expect(
        execute(makeNode("fetch_pr_context"), {}, prTriggerCtx()),
      ).rejects.toBe(error);
    });

    it("reads threads only for the triggering PR's own repository", async () => {
      mocks.env.REVIEW_LEDGER_ENABLED = true;
      const sibling = vi.fn();
      const own = vi.fn().mockResolvedValue(feed);
      mocks.createRepositoryVCS.mockImplementation(
        ({ repoPath }: { repoPath: string }) => ({
          getPRComments: vi.fn().mockResolvedValue([]),
          getCheckRunResults: vi.fn().mockResolvedValue([]),
          getPRConflictStatus: vi.fn().mockResolvedValue(false),
          listReviewThreads: repoPath === "acme/api" ? own : sibling,
        }),
      );
      const ctx = prTriggerCtx();
      ctx.selectedRepositories = [
        repoWithPr,
        {
          ...repoWithPr,
          repoPath: "acme/contract",
          workflowOwnedBranch: {
            branchName: "blazebot/awt-1",
            pr: { id: 13, url: "https://pr/13", branch: "blazebot/awt-1" },
          },
        },
      ];

      await execute(makeNode("fetch_pr_context"), {}, ctx);

      expect(own).toHaveBeenCalledWith(7);
      expect(sibling).not.toHaveBeenCalled();
    });
  });

  it.each(runControlErrorCases())("rethrows %s from context loading", async (_label, error) => {
    mocks.createRepositoryVCS.mockReturnValue({
      getPRComments: vi.fn().mockRejectedValue(error),
      getCheckRunResults: vi.fn(),
      getPRConflictStatus: vi.fn(),
    });

    await expect(
      execute(
        makeNode("fetch_pr_context"),
        {},
        makeCtx({ selectedRepositories: [repoWithPr] }),
      ),
    ).rejects.toBe(error);
  });
});

describe("PR trigger multi-repo review selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
  });

  it("adds a sibling PR as read-only context at its current head", async () => {
    const pr = makePrPayload();
    mocks.findRunPrSiblings.mockResolvedValue({
      status: "siblings",
      runId: "implementation-run",
      current: {
        provider: pr.provider,
        repoPath: pr.repoPath,
        id: pr.prNumber,
        url: pr.prUrl,
        headSha: pr.headSha,
      },
      siblings: [
        {
          provider: "gitlab",
          repoPath: "acme/api-contract",
          id: 13,
          url: "https://gitlab.test/acme/api-contract/-/merge_requests/13",
          headSha: "published-sha",
        },
      ],
    });
    mocks.listRepositories.mockResolvedValue([
      {
        provider: "gitlab",
        repoPath: "acme/api-contract",
        name: "api-contract",
        owner: "acme",
        defaultBranch: "main",
        description: "",
        webUrl: "https://gitlab.test/acme/api-contract",
        topics: [],
        archived: false,
        private: true,
      },
    ]);
    mocks.createRepositoryVCS.mockReturnValue({
      getPRHead: vi.fn().mockResolvedValue({
        state: "open",
        headRef: "feature/api-contract",
        headSha: "current-sibling-sha",
      }),
      getBranchShaIfExists: vi.fn().mockImplementation(
        async (branch: string) =>
          branch === "feature/api-contract" ? "current-sibling-sha" : "default-branch-sha",
      ),
    });

    const repositories = await blockPrTriggerRepositoriesWithSiblingsStep(
      "review-run",
      pr,
    );

    expect(repositories).toHaveLength(2);
    expect(repositories[0]).toMatchObject({
      repoPath: pr.repoPath,
      workflowOwnedBranch: { branchName: pr.headRef },
    });
    expect(repositories[1]).toMatchObject({
      provider: "gitlab",
      repoPath: "acme/api-contract",
      reviewPullRequest: {
        id: 13,
        branch: "feature/api-contract",
        headSha: "current-sibling-sha",
      },
    });
    expect(repositories[1]?.workflowOwnedBranch).toBeUndefined();
  });

  it.each([
    { label: "closed PR", state: "closed" as const, sourceBranchSha: "closed-sha" },
    { label: "fork PR", state: "open" as const, sourceBranchSha: null },
  ])("falls back to the pinned default branch for a $label", async ({
    state,
    sourceBranchSha,
  }) => {
    const pr = makePrPayload();
    mocks.findRunPrSiblings.mockResolvedValue({
      status: "siblings",
      runId: "implementation-run",
      current: {
        provider: pr.provider,
        repoPath: pr.repoPath,
        id: pr.prNumber,
        url: pr.prUrl,
        headSha: pr.headSha,
      },
      siblings: [
        {
          provider: "gitlab",
          repoPath: "acme/api-contract",
          id: 13,
          url: "https://gitlab.test/acme/api-contract/-/merge_requests/13",
          headSha: "published-sha",
        },
      ],
    });
    mocks.listRepositories.mockResolvedValue([
      {
        provider: "gitlab",
        repoPath: "acme/api-contract",
        name: "api-contract",
        owner: "acme",
        defaultBranch: "main",
        description: "",
        webUrl: "https://gitlab.test/acme/api-contract",
        topics: [],
        archived: false,
        private: true,
      },
    ]);
    const getBranchShaIfExists = vi.fn().mockImplementation(
      async (branch: string) =>
        branch === "feature/api-contract" ? sourceBranchSha : "default-branch-sha",
    );
    mocks.createRepositoryVCS.mockReturnValue({
      getPRHead: vi.fn().mockResolvedValue({
        state,
        headRef: "feature/api-contract",
        headSha: "closed-sibling-sha",
      }),
      getBranchShaIfExists,
    });

    const repositories = await blockPrTriggerRepositoriesWithSiblingsStep(
      "review-run",
      pr,
    );

    expect(repositories[1]?.reviewPullRequest).toMatchObject({
      branch: "main",
      headSha: "default-branch-sha",
    });
  });

  it("does not read a sibling repository outside the agent allowlist", async () => {
    process.env.AGENT_ALLOWED_REPOS = "acme/web";
    const pr = makePrPayload();
    mocks.findRunPrSiblings.mockResolvedValue({
      status: "siblings",
      runId: "implementation-run",
      current: {
        provider: pr.provider,
        repoPath: pr.repoPath,
        id: pr.prNumber,
        url: pr.prUrl,
        headSha: pr.headSha,
      },
      siblings: [
        {
          provider: "gitlab",
          repoPath: "acme/api-contract",
          id: 13,
          url: "https://gitlab.test/acme/api-contract/-/merge_requests/13",
          headSha: "published-sha",
        },
      ],
    });
    mocks.listRepositories.mockResolvedValue([
      {
        provider: "gitlab",
        repoPath: "acme/api-contract",
        name: "api-contract",
        owner: "acme",
        defaultBranch: "main",
        description: "",
        webUrl: "https://gitlab.test/acme/api-contract",
        topics: [],
        archived: false,
        private: true,
      },
    ]);

    const repositories = await blockPrTriggerRepositoriesWithSiblingsStep(
      "review-run",
      pr,
    );

    expect(repositories).toHaveLength(1);
    expect(repositories[0]?.repoPath).toBe(pr.repoPath);
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: "acme/api-contract" }),
      "review_sibling_repository_not_allowed",
    );
  });
});
