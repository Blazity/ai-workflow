import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRepositoryVCS: vi.fn(),
  getDb: vi.fn(),
  listWorkflowOwnedBranchesForTicket: vi.fn(),
  findRunPrSiblings: vi.fn(),
  listRepositories: vi.fn(),
  warn: vi.fn(),
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
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: mocks.warn },
}));

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
});
