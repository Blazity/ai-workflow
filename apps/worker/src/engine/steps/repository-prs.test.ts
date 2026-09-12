import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  createRepositoryVCS: vi.fn(),
  upsertWorkflowOwnedBranch: vi.fn(),
  assertActiveRunOwner: vi.fn(),
}));

vi.mock("../../db/client.js", () => ({
  getDb: mocks.getDb,
}));

vi.mock("../../engine/support/vcs-runtime.js", () => ({
  createRepositoryVCS: mocks.createRepositoryVCS,
}));

vi.mock("../../db/repositories/runs.js", () => ({
  upsertWorkflowOwnedBranch: mocks.upsertWorkflowOwnedBranch,
  upsertConnectedWorkflowOwnedBranch: (...args: any[]) =>
    mocks.upsertWorkflowOwnedBranch(...args),
}));

vi.mock("../../db/repositories/active-runs.js", () => ({
  assertActiveRunOwner: (...args: any[]) => mocks.assertActiveRunOwner(...args),
  assertConnectedActiveRunOwner: (...args: any[]) =>
    mocks.assertActiveRunOwner(...args),
}));

import {
  createOrFindWorkflowOwnedPullRequest,
  findWorkflowOwnedPullRequestForBranch,
  recordWorkflowOwnedPullRequest,
  recordWorkflowOwnedPullRequestIntent,
} from "./repository-prs.js";

const durableOwner = {
  subjectKey: "ticket:jira:AIW-100",
  ownerToken: "owner-1",
  runId: "run-1",
};

describe("durable publication PR phases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.assertActiveRunOwner.mockResolvedValue(undefined);
  });

  it("refuses PR creation on a repository the run's catalog does not enable", async () => {
    mocks.createRepositoryVCS.mockReturnValue({
      findPR: vi.fn().mockResolvedValue(null),
      createPR: vi.fn(),
    });

    await expect(
      createOrFindWorkflowOwnedPullRequest({
        branchName: "blazebot/aiw-100",
        repository: {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "publication outside the catalog",
        },
        title: "Publication outside the catalog",
        body: "",
        owner: durableOwner,
        repositoryAccess: { activated: true, enabledKeys: ["github:acme/other"] },
      }),
    ).rejects.toThrow("not enabled in the repository catalog");
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });

  it("opens a PR on a repository the run's catalog enables, matching case-insensitively", async () => {
    mocks.createRepositoryVCS.mockReturnValue({
      findPR: vi.fn().mockResolvedValue(null),
      createPR: vi.fn().mockResolvedValue({
        id: 46,
        url: "https://github.com/acme/api/pull/46",
        branch: "blazebot/aiw-100",
      }),
    });

    await expect(
      createOrFindWorkflowOwnedPullRequest({
        branchName: "blazebot/aiw-100",
        repository: {
          provider: "github",
          // The operator typed the row one way and the provider lists it
          // another; the catalog key is cased down so both name one repository.
          repoPath: "Acme/API",
          defaultBranch: "main",
          selectedRationale: "enabled publication",
        },
        title: "Enabled publication",
        body: "",
        owner: durableOwner,
        repositoryAccess: { activated: true, enabledKeys: ["github:acme/api"] },
      }),
    ).resolves.toMatchObject({ provider: "github", repoPath: "Acme/API" });
  });

  it("reaches every repository while the catalog is not activated", async () => {
    mocks.createRepositoryVCS.mockReturnValue({
      findPR: vi.fn().mockResolvedValue(null),
      createPR: vi.fn().mockResolvedValue({
        id: 47,
        url: "https://github.com/acme/api/pull/47",
        branch: "blazebot/aiw-100",
      }),
    });

    await expect(
      createOrFindWorkflowOwnedPullRequest({
        branchName: "blazebot/aiw-100",
        repository: {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "bridge publication",
        },
        title: "Bridge publication",
        body: "",
        owner: durableOwner,
        repositoryAccess: { activated: false, enabledKeys: [] },
      }),
    ).resolves.toMatchObject({ provider: "github", repoPath: "acme/api" });
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
      body: "## What changed\nThings.",
      owner: durableOwner,
    // Not about the catalog: the bridge, where everything is reachable.
    repositoryAccess: { activated: false, enabledKeys: [] },
    });

    expect(order).toEqual(["reconcile", "owner-fence", "create"]);
    expect(mocks.assertActiveRunOwner).toHaveBeenCalledWith(durableOwner);
    // The resolved title is handed to the provider verbatim, and a body with no
    // platform vocabulary survives the publication scrub unchanged.
    expect(createPR).toHaveBeenCalledWith(
      "blazebot/aiw-100",
      "Safe publication",
      "## What changed\nThings.",
    );
  });

  it("scrubs platform bookkeeping out of the PR body before the provider sees it", async () => {
    const createPR = vi.fn().mockResolvedValue({
      id: 49,
      url: "https://github.com/acme/api/pull/49",
      branch: "blazebot/aiw-100",
    });
    mocks.createRepositoryVCS.mockReturnValue({
      findPR: vi.fn().mockResolvedValue(null),
      createPR,
    });

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
      body:
        "## What changed\nAdded the toggle. Updated session memory at " +
        "`blazebot/memory/AIW-100.md`. I did not push or open a PR.",
      owner: durableOwner,
    // Not about the catalog: the bridge, where everything is reachable.
    repositoryAccess: { activated: false, enabledKeys: [] },
    });

    expect(createPR).toHaveBeenCalledWith(
      "blazebot/aiw-100",
      "Safe publication",
      "## What changed\nAdded the toggle.",
    );
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
        body: "## What changed\nThings.",
        owner: durableOwner,
      // Not about the catalog: the bridge, where everything is reachable.
      repositoryAccess: { activated: false, enabledKeys: [] },
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
      body: "## What changed\nThings.",
      owner: durableOwner,
    // Not about the catalog: the bridge, where everything is reachable.
    repositoryAccess: { activated: false, enabledKeys: [] },
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
        body: "## What changed\nThings.",
        owner: durableOwner,
      // Not about the catalog: the bridge, where everything is reachable.
      repositoryAccess: { activated: false, enabledKeys: [] },
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
