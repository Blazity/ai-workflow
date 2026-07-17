import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  createRepositoryVCS: vi.fn(),
  upsertWorkflowOwnedBranch: vi.fn(),
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

import {
  createOrFindWorkflowOwnedPullRequest,
  createOrUseWorkflowOwnedPullRequestsForRepos,
  prepareSelectedRepositoryBranches,
  recordWorkflowOwnedPullRequest,
} from "./repository-prs.js";

describe("prepareSelectedRepositoryBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
  });

  it("creates branches and records ownership for repositories without workflow-owned branches", async () => {
    const createBranch = vi.fn().mockResolvedValue(undefined);
    mocks.createRepositoryVCS.mockReturnValue({ createBranch });

    await prepareSelectedRepositoryBranches("AIW-45", "blazebot/aiw-45", [
      {
        provider: "github",
        repoPath: "acme/api",
        defaultBranch: "main",
        selectedRationale: "ticket mentions api",
      },
    ]);

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

    await prepareSelectedRepositoryBranches("AIW-45", "blazebot/aiw-45", [
      {
        provider: "github",
        repoPath: "acme/web",
        defaultBranch: "main",
        selectedRationale: "workflow-owned branch for this ticket",
        workflowOwnedBranch: { branchName: "blazebot/aiw-45" },
      },
    ]);

    expect(createBranch).not.toHaveBeenCalled();
    expect(mocks.upsertWorkflowOwnedBranch).not.toHaveBeenCalled();
  });
});

describe("createOrUseWorkflowOwnedPullRequestsForRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
  });

  it("reuses existing workflow-owned PR metadata", async () => {
    const createPR = vi.fn();
    mocks.createRepositoryVCS.mockReturnValue({ createPR });

    const prs = await createOrUseWorkflowOwnedPullRequestsForRepos({
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
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
    mocks.createRepositoryVCS.mockReturnValue({ createPR });

    const prs = await createOrUseWorkflowOwnedPullRequestsForRepos({
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
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
    mocks.createRepositoryVCS.mockReturnValue({ createPR });

    await createOrUseWorkflowOwnedPullRequestsForRepos({
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
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
  });

  it("returns the provider PR before writing workflow-owned branch correlation", async () => {
    mocks.createRepositoryVCS.mockReturnValue({
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
    });

    expect(pr).toEqual(expect.objectContaining({ id: 46, repoPath: "acme/api" }));
    expect(mocks.upsertWorkflowOwnedBranch).not.toHaveBeenCalled();
  });

  it("records workflow-owned branch correlation as a separate idempotent phase", async () => {
    await recordWorkflowOwnedPullRequest({
      ticketKey: "AIW-100",
      publishedHeadSha: "published-sha",
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
        pr: {
          id: 46,
          url: "https://github.com/acme/api/pull/46",
          branch: "blazebot/aiw-100",
        },
      },
    );
  });
});
