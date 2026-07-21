import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  createRepositoryVCS: vi.fn(),
  upsertWorkflowOwnedBranch: vi.fn(),
  assertActiveRunOwner: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  getDb: mocks.getDb,
}));

vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: mocks.createRepositoryVCS,
}));

vi.mock("../db/queries/workflow-owned-branches.js", () => ({
  upsertWorkflowOwnedBranch: mocks.upsertWorkflowOwnedBranch,
}));

vi.mock("../lib/active-run-owner.js", () => ({
  assertActiveRunOwner: (...args: any[]) => mocks.assertActiveRunOwner(...args),
}));

import {
  createOrFindWorkflowOwnedPullRequest,
  createOrUseWorkflowOwnedPullRequestsForRepos,
  findWorkflowOwnedPullRequestForBranch,
  prepareSelectedRepositoryBranches,
  recordWorkflowOwnedPullRequest,
  recordWorkflowOwnedPullRequestIntent,
} from "./repository-prs.js";

const durableOwner = {
  subjectKey: "ticket:jira:AIW-100",
  ownerToken: "owner-1",
  runId: "run-1",
};

describe("prepareSelectedRepositoryBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.assertActiveRunOwner.mockResolvedValue(undefined);
  });

  it("creates branches and records ownership for repositories without workflow-owned branches", async () => {
    const createBranch = vi.fn().mockResolvedValue(undefined);
    mocks.createRepositoryVCS.mockReturnValue({ createBranch });

    await prepareSelectedRepositoryBranches(
      "AIW-45",
      "blazebot/aiw-45",
      [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "ticket mentions api",
        },
      ],
      durableOwner,
    );

    expect(createBranch).toHaveBeenCalledWith("blazebot/aiw-45", "main");
    expect(mocks.createRepositoryVCS).toHaveBeenCalledWith({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
    });
    expect(mocks.upsertWorkflowOwnedBranch).toHaveBeenCalledWith({ db: true }, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/api",
      branchName: "blazebot/aiw-45",
    });
  });

  it("skips branch creation when ownership already exists", async () => {
    const createBranch = vi.fn().mockResolvedValue(undefined);
    mocks.createRepositoryVCS.mockReturnValue({ createBranch });

    await prepareSelectedRepositoryBranches(
      "AIW-45",
      "blazebot/aiw-45",
      [
        {
          provider: "github",
          repoPath: "acme/web",
          defaultBranch: "main",
          selectedRationale: "workflow-owned branch for this ticket",
          workflowOwnedBranch: { branchName: "blazebot/aiw-45" },
        },
      ],
      durableOwner,
    );

    expect(createBranch).not.toHaveBeenCalled();
    expect(mocks.upsertWorkflowOwnedBranch).not.toHaveBeenCalled();
  });

  it("reasserts the exact active owner before each repository branch creation", async () => {
    const createBranch = vi.fn().mockResolvedValue(undefined);
    mocks.createRepositoryVCS.mockReturnValue({ createBranch });
    mocks.assertActiveRunOwner
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new Error("Provider mutation requires the exact active run owner."),
      );

    await expect(
      prepareSelectedRepositoryBranches(
        "AIW-45",
        "blazebot/aiw-45",
        [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
          {
            provider: "github",
            repoPath: "acme/web",
            defaultBranch: "main",
            selectedRationale: "ticket mentions web",
          },
        ],
        durableOwner,
      ),
    ).rejects.toThrow("exact active run owner");

    expect(mocks.assertActiveRunOwner).toHaveBeenCalledTimes(2);
    expect(createBranch).toHaveBeenCalledTimes(1);
    expect(createBranch).toHaveBeenCalledWith("blazebot/aiw-45", "main");
    expect(mocks.upsertWorkflowOwnedBranch).toHaveBeenCalledTimes(1);
  });
});

describe("createOrUseWorkflowOwnedPullRequestsForRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
  });

  it("reuses existing workflow-owned PR metadata", async () => {
    const createPR = vi.fn();
    mocks.createRepositoryVCS.mockReturnValue({
      createPR,
      findPR: vi.fn().mockResolvedValue(null),
    });

    const prs = await createOrUseWorkflowOwnedPullRequestsForRepos({
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
      owner: durableOwner,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          defaultBranch: "main",
          selectedRationale: "workflow-owned branch for this ticket",
          workflowOwnedBranch: {
            branchName: "blazebot/aiw-45",
            pr: { id: 42, url: "https://pr", branch: "blazebot/aiw-45" },
          },
        },
      ],
      title: "Fix web",
    });

    expect(createPR).not.toHaveBeenCalled();
    expect(prs).toEqual([{
      provider: "github",
      repoPath: "acme/web",
      id: 42,
      url: "https://pr",
      branch: "blazebot/aiw-45",
      isNew: false,
    }]);
  });

  it("creates PRs and records PR metadata when no workflow-owned PR exists", async () => {
    const createPR = vi.fn().mockResolvedValue({
      id: 43,
      url: "https://github.com/acme/api/pull/43",
      branch: "blazebot/aiw-45",
    });
    mocks.createRepositoryVCS.mockReturnValue({
      createPR,
      findPR: vi.fn().mockResolvedValue(null),
    });

    const prs = await createOrUseWorkflowOwnedPullRequestsForRepos({
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
      owner: durableOwner,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "ticket mentions api",
          workflowOwnedBranch: { branchName: "blazebot/aiw-45" },
        },
      ],
      title: "Fix API",
    });

    expect(createPR).toHaveBeenCalledWith("blazebot/aiw-45", "Fix API", "");
    expect(mocks.assertActiveRunOwner).toHaveBeenCalledWith({ db: true }, durableOwner);
    expect(mocks.upsertWorkflowOwnedBranch).toHaveBeenCalledWith({ db: true }, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/api",
      branchName: "blazebot/aiw-45",
      pr: {
        id: 43,
        url: "https://github.com/acme/api/pull/43",
        branch: "blazebot/aiw-45",
      },
    });
    expect(prs).toEqual([
      {
        provider: "github",
        repoPath: "acme/api",
        id: 43,
        url: "https://github.com/acme/api/pull/43",
        branch: "blazebot/aiw-45",
        isNew: true,
      },
    ]);
  });

  it("creates merge requests with the selected repository provider config", async () => {
    const createPR = vi.fn().mockResolvedValue({
      id: 44,
      url: "https://gitlab.example.com/acme/api/-/merge_requests/44",
      branch: "blazebot/aiw-45",
    });
    mocks.createRepositoryVCS.mockReturnValue({
      createPR,
      findPR: vi.fn().mockResolvedValue(null),
    });

    await createOrUseWorkflowOwnedPullRequestsForRepos({
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
      owner: durableOwner,
      repositories: [
        {
          provider: "gitlab",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "ticket mentions api",
          workflowOwnedBranch: { branchName: "blazebot/aiw-45" },
        },
      ],
      title: "Fix API",
    });

    expect(mocks.createRepositoryVCS).toHaveBeenCalledWith({
      provider: "gitlab",
      repoPath: "acme/api",
      baseBranch: "main",
    });
  });

  it("records an already-open provider PR before returning it", async () => {
    const existing = {
      id: 45,
      url: "https://github.com/acme/api/pull/45",
      branch: "blazebot/aiw-45",
    };
    const createPR = vi.fn().mockRejectedValue(new Error("A pull request already exists"));
    const findPR = vi.fn().mockResolvedValue(existing);
    mocks.createRepositoryVCS.mockReturnValue({ createPR, findPR });

    const prs = await createOrUseWorkflowOwnedPullRequestsForRepos({
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
      owner: durableOwner,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "ticket mentions api",
          workflowOwnedBranch: { branchName: "blazebot/aiw-45" },
        },
      ],
      title: "Fix API",
    });

    expect(findPR).toHaveBeenCalledWith("blazebot/aiw-45");
    expect(mocks.upsertWorkflowOwnedBranch).toHaveBeenCalledWith({ db: true }, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/api",
      branchName: "blazebot/aiw-45",
      pr: existing,
    });
    expect(prs).toEqual([
      {
        provider: "github",
        repoPath: "acme/api",
        id: 45,
        url: "https://github.com/acme/api/pull/45",
        branch: "blazebot/aiw-45",
        isNew: false,
      },
    ]);
  });
});

describe("durable publication PR phases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.assertActiveRunOwner.mockResolvedValue(undefined);
  });

  it("reasserts the exact active owner immediately before provider PR creation", async () => {
    const order: string[] = [];
    const findPR = vi.fn().mockImplementation(async () => {
      order.push("reconcile");
      return null;
    });
    const createPR = vi.fn().mockImplementation(async () => {
      order.push("create");
      return {
        id: 46,
        url: "https://github.com/acme/api/pull/46",
        branch: "blazebot/aiw-100",
      };
    });
    mocks.assertActiveRunOwner.mockImplementation(async () => {
      order.push("owner-fence");
    });
    mocks.createRepositoryVCS.mockReturnValue({ findPR, createPR });
    await createOrFindWorkflowOwnedPullRequest({
      branchName: "blazebot/aiw-100",
      repository: {
        provider: "github",
        repoPath: "acme/api",
        defaultBranch: "main",
        selectedRationale: "durable finalized publication",
        workflowOwnedBranch: { branchName: "blazebot/aiw-100" },
      },
      title: "Safe publication",
      owner: durableOwner,
    });

    expect(order).toEqual(["reconcile", "owner-fence", "create"]);
    expect(mocks.assertActiveRunOwner).toHaveBeenCalledWith({ db: true }, durableOwner);
  });

  it("does not create a provider PR when cancellation wins after reconciliation", async () => {
    const createPR = vi.fn();
    const findPR = vi.fn().mockResolvedValue(null);
    mocks.createRepositoryVCS.mockReturnValue({
      findPR,
      createPR,
    });
    const ownerLoss = new Error("Provider mutation requires the exact active run owner.");
    ownerLoss.name = "ActiveRunOwnerError";
    mocks.assertActiveRunOwner.mockRejectedValue(ownerLoss);

    await expect(
      createOrFindWorkflowOwnedPullRequest({
        branchName: "blazebot/aiw-100",
        repository: {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "durable finalized publication",
          workflowOwnedBranch: { branchName: "blazebot/aiw-100" },
        },
        title: "Safe publication",
        owner: durableOwner,
      }),
    ).rejects.toBe(ownerLoss);
    expect(findPR).toHaveBeenCalledOnce();
    expect(createPR).not.toHaveBeenCalled();
  });

  it("returns the provider PR before writing workflow-owned branch correlation", async () => {
    mocks.createRepositoryVCS.mockReturnValue({
      findPR: vi.fn().mockResolvedValue(null),
      createPR: vi.fn().mockResolvedValue({
        id: 46,
        url: "https://github.com/acme/api/pull/46",
        branch: "blazebot/aiw-100",
      }),
    });

    const pr = await createOrFindWorkflowOwnedPullRequest({
      branchName: "blazebot/aiw-100",
      repository: {
        provider: "github",
        repoPath: "acme/api",
        defaultBranch: "main",
        selectedRationale: "durable finalized publication",
        workflowOwnedBranch: { branchName: "blazebot/aiw-100" },
      },
      title: "Safe publication",
      owner: durableOwner,
    });

    expect(pr).toEqual(expect.objectContaining({ id: 46, repoPath: "acme/api" }));
    expect(mocks.upsertWorkflowOwnedBranch).not.toHaveBeenCalled();
  });

  it("reconciles a PR created remotely before an ambiguous timeout", async () => {
    const existing = {
      id: 47,
      url: "https://github.com/acme/api/pull/47",
      branch: "blazebot/aiw-100",
    };
    const findPR = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    const createPR = vi
      .fn()
      .mockRejectedValueOnce(new Error("request timed out after provider accepted it"));
    mocks.createRepositoryVCS.mockReturnValue({ findPR, createPR });

    await expect(
      createOrFindWorkflowOwnedPullRequest({
        branchName: "blazebot/aiw-100",
        repository: {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "durable finalized publication",
          workflowOwnedBranch: { branchName: "blazebot/aiw-100" },
        },
        title: "Safe publication",
        owner: durableOwner,
      }),
    ).resolves.toEqual({
      provider: "github",
      repoPath: "acme/api",
      ...existing,
      isNew: false,
    });
    expect(findPR).toHaveBeenCalledTimes(2);
    expect(createPR).toHaveBeenCalledOnce();
  });

  it("finds an existing provider PR without entering the create phase", async () => {
    const existing = {
      id: 48,
      url: "https://github.com/acme/api/pull/48",
      branch: "blazebot/aiw-100",
    };
    const findPR = vi.fn().mockResolvedValue(existing);
    const createPR = vi.fn();
    mocks.createRepositoryVCS.mockReturnValue({ findPR, createPR });

    await expect(
      findWorkflowOwnedPullRequestForBranch({
        branchName: "blazebot/aiw-100",
        repository: {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "durable finalized publication",
          workflowOwnedBranch: { branchName: "blazebot/aiw-100" },
        },
      }),
    ).resolves.toEqual({
      provider: "github",
      repoPath: "acme/api",
      ...existing,
      isNew: false,
    });
    expect(findPR).toHaveBeenCalledOnce();
    expect(createPR).not.toHaveBeenCalled();
  });

  it("records an exact branch/head intent before the provider PR id is known", async () => {
    await recordWorkflowOwnedPullRequestIntent({
      ticketKey: "AIW-100",
      provider: "github",
      repoPath: "acme/api",
      branchName: "blazebot/aiw-100",
      publishedHeadSha: "published-sha",
      targetBranch: "main",
    });

    expect(mocks.upsertWorkflowOwnedBranch).toHaveBeenCalledWith(
      { db: true },
      {
        ticketKey: "AIW-100",
        provider: "github",
        repoPath: "acme/api",
        branchName: "blazebot/aiw-100",
        publishedHeadSha: "published-sha",
        targetBranch: "main",
        prCorrelationPending: true,
      },
    );
  });

  it("records workflow-owned branch correlation as a separate idempotent phase", async () => {
    await recordWorkflowOwnedPullRequest({
      ticketKey: "AIW-100",
      publishedHeadSha: "published-sha",
      targetBranch: "main",
      pr: {
        provider: "github",
        repoPath: "acme/api",
        id: 46,
        url: "https://github.com/acme/api/pull/46",
        branch: "blazebot/aiw-100",
        isNew: true,
      },
    });

    expect(mocks.upsertWorkflowOwnedBranch).toHaveBeenCalledWith(
      { db: true },
      {
        ticketKey: "AIW-100",
        provider: "github",
        repoPath: "acme/api",
        branchName: "blazebot/aiw-100",
        publishedHeadSha: "published-sha",
        targetBranch: "main",
        pr: {
          id: 46,
          url: "https://github.com/acme/api/pull/46",
          branch: "blazebot/aiw-100",
        },
      },
    );
  });
});
