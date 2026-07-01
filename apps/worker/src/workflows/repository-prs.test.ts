import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getVcsConfig: vi.fn(),
  createVCSForRepository: vi.fn(),
  upsertWorkflowOwnedBranch: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  getDb: mocks.getDb,
}));

vi.mock("../../env.js", () => ({
  getVcsConfig: mocks.getVcsConfig,
}));

vi.mock("../lib/create-vcs.js", () => ({
  createVCSForRepository: mocks.createVCSForRepository,
}));

vi.mock("../db/queries/workflow-owned-branches.js", () => ({
  upsertWorkflowOwnedBranch: mocks.upsertWorkflowOwnedBranch,
}));

import {
  createOrUseWorkflowOwnedPullRequestsForRepos,
  prepareSelectedRepositoryBranches,
} from "./repository-prs.js";

const vcsConfig = {
  kind: "github" as const,
  auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
  repoPath: "default/repo",
  baseBranch: "main",
  host: "https://github.com",
};

describe("prepareSelectedRepositoryBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.getVcsConfig.mockReturnValue(vcsConfig);
  });

  it("creates branches and records ownership for repositories without workflow-owned branches", async () => {
    const createBranch = vi.fn().mockResolvedValue(undefined);
    mocks.createVCSForRepository.mockReturnValue({ createBranch });

    await prepareSelectedRepositoryBranches("AIW-45", "blazebot/aiw-45", [
      {
        provider: "github",
        repoPath: "acme/api",
        defaultBranch: "main",
        selectedRationale: "ticket mentions api",
      },
    ]);

    expect(createBranch).toHaveBeenCalledWith("blazebot/aiw-45", "main");
    expect(mocks.upsertWorkflowOwnedBranch).toHaveBeenCalledWith({ db: true }, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/api",
      branchName: "blazebot/aiw-45",
    });
  });

  it("skips branch creation when ownership already exists", async () => {
    const createBranch = vi.fn().mockResolvedValue(undefined);
    mocks.createVCSForRepository.mockReturnValue({ createBranch });

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
    mocks.getVcsConfig.mockReturnValue(vcsConfig);
  });

  it("reuses existing workflow-owned PR metadata", async () => {
    const createPR = vi.fn();
    mocks.createVCSForRepository.mockReturnValue({ createPR });

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
    expect(prs).toEqual([{ repoPath: "acme/web", id: 42, url: "https://pr", branch: "blazebot/aiw-45", isNew: false }]);
  });

  it("creates PRs and records PR metadata when no workflow-owned PR exists", async () => {
    const createPR = vi.fn().mockResolvedValue({
      id: 43,
      url: "https://github.com/acme/api/pull/43",
      branch: "blazebot/aiw-45",
    });
    mocks.createVCSForRepository.mockReturnValue({ createPR });

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
        repoPath: "acme/api",
        id: 43,
        url: "https://github.com/acme/api/pull/43",
        branch: "blazebot/aiw-45",
        isNew: true,
      },
    ]);
  });
});
