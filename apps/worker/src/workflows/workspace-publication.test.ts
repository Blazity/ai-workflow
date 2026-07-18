import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";

const mocks = vi.hoisted(() => ({
  pushWorkspaceFromSandbox: vi.fn(),
  createOrFindWorkflowOwnedPullRequest: vi.fn(),
  recordWorkflowOwnedPullRequest: vi.fn(),
  writeHumanDecisionsMemory: vi.fn(),
  createRepositoryVcsRuntime: vi.fn(),
  getDb: vi.fn(() => ({ db: true })),
  createOrGetPublicationAttempt: vi.fn(),
  getPublicationAttempt: vi.fn(),
  markPublicationAttemptPushing: vi.fn(),
  markPublicationAttemptFinalized: vi.fn(),
  markPublicationAttemptCreatingPrs: vi.fn(),
  markPublicationAttemptPublished: vi.fn(),
  recordPublicationRepositoryPreflight: vi.fn(),
  recordPublicationRepositoryPush: vi.fn(),
  recordPublicationRepositoryFailure: vi.fn(),
  recordPublicationPullRequest: vi.fn(),
  failPublicationAttempt: vi.fn(),
}));

vi.mock("../sandbox/poll-agent.js", () => ({
  pushWorkspaceFromSandbox: mocks.pushWorkspaceFromSandbox,
}));
vi.mock("../sandbox/write-human-decisions-memory.js", () => ({
  writeHumanDecisionsMemory: mocks.writeHumanDecisionsMemory,
}));
vi.mock("./repository-prs.js", () => ({
  createOrFindWorkflowOwnedPullRequest: mocks.createOrFindWorkflowOwnedPullRequest,
  recordWorkflowOwnedPullRequest: mocks.recordWorkflowOwnedPullRequest,
}));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVcsRuntime: mocks.createRepositoryVcsRuntime,
}));
vi.mock("../db/client.js", () => ({ getDb: mocks.getDb }));
vi.mock("../publication/store.js", () => ({
  createOrGetPublicationAttempt: mocks.createOrGetPublicationAttempt,
  getPublicationAttempt: mocks.getPublicationAttempt,
  markPublicationAttemptPushing: mocks.markPublicationAttemptPushing,
  markPublicationAttemptFinalized: mocks.markPublicationAttemptFinalized,
  markPublicationAttemptCreatingPrs: mocks.markPublicationAttemptCreatingPrs,
  markPublicationAttemptPublished: mocks.markPublicationAttemptPublished,
  recordPublicationRepositoryPreflight: mocks.recordPublicationRepositoryPreflight,
  recordPublicationRepositoryPush: mocks.recordPublicationRepositoryPush,
  recordPublicationRepositoryFailure: mocks.recordPublicationRepositoryFailure,
  recordPublicationPullRequest: mocks.recordPublicationPullRequest,
  failPublicationAttempt: mocks.failPublicationAttempt,
}));

import {
  finalizeWorkspacePublication,
  openPullRequestsForPublication,
} from "./workspace-publication.js";

const selectedRepositories: SelectedRepository[] = [
  {
    provider: "github",
    repoPath: "acme/web",
    defaultBranch: "main",
    selectedRationale: "ticket mentions web",
  },
  {
    provider: "gitlab",
    repoPath: "acme/api",
    defaultBranch: "main",
    selectedRationale: "ticket mentions api",
  },
];

function repository(
  provider: "github" | "gitlab",
  repoPath: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    provider,
    repoPath,
    branchName: "blazebot/aiw-100",
    defaultBranch: "main",
    changed: true,
    expectedHead: `${repoPath}-before`,
    targetHead: `${repoPath}-after`,
    pushedHead: `${repoPath}-after`,
    pr: null,
    failure: null,
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1",
    runId: "run-1",
    blockId: "finalize",
    status: "preflighting",
    failure: null,
    repositories: [
      repository("github", "acme/web"),
      repository("gitlab", "acme/api"),
    ],
    ...overrides,
  };
}

describe("finalizeWorkspacePublication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: true,
      attempt: attempt({ status: "preflighting" }),
    });
  });

  it("fails a stale triggering PR head before any git push", async () => {
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: { getPRHeadSha: vi.fn().mockResolvedValue("newer-provider-head") },
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
      sourcePullRequest: {
        provider: "github",
        repoPath: "acme/web",
        prId: 12,
        headSha: "trigger-head",
      },
    });

    expect(publication).toEqual(
      expect.objectContaining({ status: "failed", attemptId: "attempt-1" }),
    );
    expect(publication.status === "failed" ? publication.reason : "").toContain(
      "newer-provider-head",
    );
    expect(mocks.pushWorkspaceFromSandbox).not.toHaveBeenCalled();
    expect(mocks.recordPublicationRepositoryFailure).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/web", failure: expect.stringContaining("stale") }),
    );
    expect(mocks.failPublicationAttempt).toHaveBeenCalled();
  });

  it("records a cross-provider partial push durably and creates no PR", async () => {
    mocks.pushWorkspaceFromSandbox.mockResolvedValue({
      pushed: false,
      error: "gitlab:acme/api: provider unavailable",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-100",
          changed: true,
          pushed: true,
          expectedHead: "web-before",
          pushedHead: "web-after",
        },
        {
          provider: "gitlab",
          repoPath: "acme/api",
          branchName: "blazebot/aiw-100",
          changed: true,
          pushed: false,
          expectedHead: "api-before",
          failureKind: "push_failed",
          error: "provider unavailable",
        },
      ],
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication.status).toBe("failed");
    expect(mocks.recordPublicationRepositoryPush).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/web", pushedHead: "web-after" }),
    );
    expect(mocks.recordPublicationRepositoryPreflight).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/api", failure: "provider unavailable" }),
    );
    expect(mocks.failPublicationAttempt).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
      "gitlab:acme/api: provider unavailable",
    );
    expect(mocks.createOrFindWorkflowOwnedPullRequest).not.toHaveBeenCalled();
  });

  it("returns finalized branch metadata without creating PRs", async () => {
    mocks.pushWorkspaceFromSandbox.mockResolvedValue({
      pushed: true,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-100",
          changed: true,
          pushed: true,
          expectedHead: "web-before",
          pushedHead: "web-after",
        },
      ],
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication).toEqual({
      status: "finalized",
      attemptId: "attempt-1",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-100",
          expectedHead: "web-before",
          pushedHead: "web-after",
        },
      ],
      prs: [],
    });
    expect(mocks.pushWorkspaceFromSandbox).toHaveBeenCalledWith(
      "sbx-1",
      [],
      "attempt-1",
    );
    expect(mocks.markPublicationAttemptFinalized).toHaveBeenCalledWith({ db: true }, "attempt-1");
    expect(mocks.createOrFindWorkflowOwnedPullRequest).not.toHaveBeenCalled();
  });

  it("does not push again when the run/block attempt already exists", async () => {
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: false,
      attempt: attempt({ status: "finalized" }),
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.pushWorkspaceFromSandbox).not.toHaveBeenCalled();
  });

  it("resumes an existing preflighting attempt instead of stranding it", async () => {
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: false,
      attempt: attempt({ status: "preflighting" }),
    });
    mocks.pushWorkspaceFromSandbox.mockResolvedValue({
      pushed: true,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-100",
          changed: true,
          pushed: true,
          expectedHead: "web-before",
          targetHead: "web-after",
          pushedHead: "web-after",
        },
      ],
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.markPublicationAttemptPushing).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
    );
    expect(mocks.pushWorkspaceFromSandbox).toHaveBeenCalledWith(
      "sbx-1",
      [],
      "attempt-1",
    );
  });

  it("replays Finalize successfully after Open PR has started", async () => {
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: false,
      attempt: attempt({ status: "creating_prs" }),
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.pushWorkspaceFromSandbox).not.toHaveBeenCalled();
  });

  it("leaves an indeterminate push error available for replay reconciliation", async () => {
    mocks.pushWorkspaceFromSandbox.mockRejectedValue(
      new Error("publication result could not be recorded"),
    );

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication).toEqual(
      expect.objectContaining({
        status: "failed",
        reason: "publication result could not be recorded",
      }),
    );
    expect(mocks.markPublicationAttemptPushing).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
    );
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("finalizes when reconciliation proves an interrupted push step already landed", async () => {
    mocks.pushWorkspaceFromSandbox.mockRejectedValue(
      new Error("publication result could not be recorded"),
    );
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "pushing",
        repositories: [repository("github", "acme/web", { pushedHead: null })],
      }),
    );
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: { getBranchSha: vi.fn().mockResolvedValue("acme/web-after") },
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.recordPublicationRepositoryPush).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/web", pushedHead: "acme/web-after" }),
    );
    expect(mocks.markPublicationAttemptFinalized).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
    );
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("reconciles a push accepted before its pushed head was recorded", async () => {
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: false,
      attempt: attempt({
        status: "pushing",
        repositories: [
          repository("github", "acme/web", { pushedHead: null }),
        ],
      }),
    });
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: { getBranchSha: vi.fn().mockResolvedValue("acme/web-after") },
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.recordPublicationRepositoryPush).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/web", pushedHead: "acme/web-after" }),
    );
    expect(mocks.markPublicationAttemptFinalized).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
    );
    expect(mocks.pushWorkspaceFromSandbox).not.toHaveBeenCalled();
  });

  it("resumes a durable push when replay reconciliation still sees the expected head", async () => {
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: false,
      attempt: attempt({
        status: "pushing",
        repositories: [
          repository("github", "acme/web", { pushedHead: null }),
        ],
      }),
    });
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: { getBranchSha: vi.fn().mockResolvedValue("acme/web-before") },
    });
    mocks.pushWorkspaceFromSandbox.mockResolvedValue({
      pushed: true,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-100",
          changed: true,
          pushed: true,
          expectedHead: "acme/web-before",
          targetHead: "acme/web-after",
          pushedHead: "acme/web-after",
        },
      ],
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.pushWorkspaceFromSandbox).toHaveBeenCalledWith(
      "sbx-1",
      [],
      "attempt-1",
    );
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("finalizes a partial multi-repository replay only after both targets are durable", async () => {
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: false,
      attempt: attempt({
        status: "pushing",
        repositories: [
          repository("github", "acme/web", { pushedHead: null }),
          repository("gitlab", "acme/api", { pushedHead: null }),
        ],
      }),
    });
    mocks.createRepositoryVcsRuntime.mockImplementation(
      ({ repoPath }: { repoPath: string }) => ({
        vcs: {
          getBranchSha: vi.fn().mockResolvedValue(
            repoPath === "acme/web" ? "acme/web-after" : "acme/api-before",
          ),
        },
      }),
    );
    mocks.pushWorkspaceFromSandbox.mockResolvedValue({
      pushed: true,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-100",
          changed: true,
          pushed: true,
          expectedHead: "acme/web-before",
          targetHead: "acme/web-after",
          pushedHead: "acme/web-after",
        },
        {
          provider: "gitlab",
          repoPath: "acme/api",
          branchName: "blazebot/aiw-100",
          changed: true,
          pushed: true,
          expectedHead: "acme/api-before",
          targetHead: "acme/api-after",
          pushedHead: "acme/api-after",
        },
      ],
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.pushWorkspaceFromSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.recordPublicationRepositoryPush).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/web", pushedHead: "acme/web-after" }),
    );
    expect(mocks.recordPublicationRepositoryPush).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/api", pushedHead: "acme/api-after" }),
    );
    const lastPushRecord = Math.max(
      ...mocks.recordPublicationRepositoryPush.mock.invocationCallOrder,
    );
    expect(lastPushRecord).toBeLessThan(
      mocks.markPublicationAttemptFinalized.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("keeps provider head-read uncertainty retryable instead of failing the attempt", async () => {
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: false,
      attempt: attempt({
        status: "pushing",
        repositories: [repository("github", "acme/web", { pushedHead: null })],
      }),
    });
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: { getBranchSha: vi.fn().mockRejectedValue(new Error("provider unavailable")) },
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
    });

    expect(publication.status).toBe("failed");
    expect(publication.status === "failed" ? publication.reason : "").toContain(
      "provider unavailable",
    );
    expect(mocks.pushWorkspaceFromSandbox).not.toHaveBeenCalled();
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
    expect(mocks.markPublicationAttemptFinalized).not.toHaveBeenCalled();
  });

  it("preserves human-decision memory writing before the push", async () => {
    mocks.pushWorkspaceFromSandbox.mockResolvedValue({
      pushed: true,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-100",
          changed: true,
          pushed: true,
          expectedHead: "web-before",
          pushedHead: "web-after",
        },
      ],
    });
    const clarifications = [{ questions: ["Which flavor?"], answer: "vanilla" }];

    await finalizeWorkspacePublication({
      runId: "run-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      branchName: "blazebot/aiw-100",
      repositories: selectedRepositories,
      clarifications,
    });

    expect(mocks.writeHumanDecisionsMemory).toHaveBeenCalledWith(
      "sbx-1",
      "AIW-100",
      clarifications,
    );
    expect(mocks.writeHumanDecisionsMemory.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pushWorkspaceFromSandbox.mock.invocationCallOrder[0],
    );
  });
});

describe("openPullRequestsForPublication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordPublicationPullRequest.mockReset().mockResolvedValue(undefined);
    mocks.recordWorkflowOwnedPullRequest.mockReset().mockResolvedValue(undefined);
    mocks.createRepositoryVcsRuntime.mockImplementation(
      ({ repoPath }: { repoPath: string }) => ({
        vcs: { getBranchSha: vi.fn().mockResolvedValue(`${repoPath}-after`) },
      }),
    );
  });

  it("refuses a failed Finalize attempt and never pushes", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({ status: "failed", failure: "lease rejected" }),
    );

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("failed");
    expect(mocks.pushWorkspaceFromSandbox).not.toHaveBeenCalled();
    expect(mocks.createOrFindWorkflowOwnedPullRequest).not.toHaveBeenCalled();
  });

  it("refuses a successful attempt that belongs to another run", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({ status: "finalized", runId: "run-other" }),
    );

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("failed");
    expect(publication.status === "failed" ? publication.reason : "").toContain(
      "belongs to run run-other",
    );
    expect(mocks.createOrFindWorkflowOwnedPullRequest).not.toHaveBeenCalled();
  });

  it("creates PRs only from a successful Finalize attempt and records each result", async () => {
    const finalized = attempt({ status: "finalized" });
    mocks.getPublicationAttempt
      .mockResolvedValueOnce(finalized)
      .mockResolvedValueOnce({
        ...finalized,
        status: "published",
        repositories: [
          repository("github", "acme/web", {
            pr: { id: 12, url: "https://github.com/acme/web/pull/12", isNew: true },
          }),
          repository("gitlab", "acme/api", {
            pr: { id: 13, url: "https://gitlab.com/acme/api/-/merge_requests/13", isNew: true },
          }),
        ],
      });
    mocks.createOrFindWorkflowOwnedPullRequest
      .mockResolvedValueOnce({
        provider: "github",
        repoPath: "acme/web",
        id: 12,
        url: "https://github.com/acme/web/pull/12",
        branch: "blazebot/aiw-100",
        isNew: true,
      })
      .mockResolvedValueOnce({
        provider: "gitlab",
        repoPath: "acme/api",
        id: 13,
        url: "https://gitlab.com/acme/api/-/merge_requests/13",
        branch: "blazebot/aiw-100",
        isNew: true,
      });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("published");
    expect(mocks.pushWorkspaceFromSandbox).not.toHaveBeenCalled();
    expect(mocks.createOrFindWorkflowOwnedPullRequest).toHaveBeenCalledTimes(2);
    expect(mocks.recordPublicationPullRequest).toHaveBeenCalledTimes(2);
    expect(mocks.recordWorkflowOwnedPullRequest).toHaveBeenCalledTimes(2);
    expect(mocks.recordPublicationPullRequest.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordWorkflowOwnedPullRequest.mock.invocationCallOrder[0],
    );
    expect(mocks.recordPublicationPullRequest.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.recordWorkflowOwnedPullRequest.mock.invocationCallOrder[1],
    );
    expect(mocks.markPublicationAttemptPublished).toHaveBeenCalledWith({ db: true }, "attempt-1");
  });

  it("refuses to create a PR when the finalized branch moved", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "finalized",
        repositories: [repository("github", "acme/web")],
      }),
    );
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: { getBranchSha: vi.fn().mockResolvedValue("newer-head") },
    });
    mocks.createOrFindWorkflowOwnedPullRequest.mockResolvedValue({
      provider: "github",
      repoPath: "acme/web",
      id: 12,
      url: "https://github.com/acme/web/pull/12",
      branch: "blazebot/aiw-100",
      isNew: true,
    });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("failed");
    expect(publication.status === "failed" ? publication.reason : "").toContain(
      "finalized branch moved",
    );
    expect(mocks.createOrFindWorkflowOwnedPullRequest).not.toHaveBeenCalled();
    expect(mocks.recordPublicationRepositoryFailure).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/web", failure: expect.stringContaining("newer-head") }),
    );
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("replays an already-published attempt without creating duplicate PRs", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "published",
        repositories: [
          repository("github", "acme/web", {
            pr: { id: 12, url: "https://github.com/acme/web/pull/12", isNew: true },
          }),
        ],
      }),
    );

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("published");
    expect(publication.prs).toHaveLength(1);
    expect(mocks.createOrFindWorkflowOwnedPullRequest).not.toHaveBeenCalled();
  });

  it("retains an earlier PR result if a later provider PR creation fails", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(attempt({ status: "finalized" }));
    mocks.createOrFindWorkflowOwnedPullRequest
      .mockResolvedValueOnce({
        provider: "github",
        repoPath: "acme/web",
        id: 12,
        url: "https://github.com/acme/web/pull/12",
        branch: "blazebot/aiw-100",
        isNew: true,
      })
      .mockRejectedValueOnce(new Error("GitLab unavailable"));

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("failed");
    expect(publication.prs).toHaveLength(1);
    expect(mocks.recordPublicationPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.recordWorkflowOwnedPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("leaves PR creation resumable when the provider result cannot be recorded", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({ status: "creating_prs", repositories: [repository("github", "acme/web")] }),
    );
    mocks.createOrFindWorkflowOwnedPullRequest.mockResolvedValue({
      provider: "github",
      repoPath: "acme/web",
      id: 12,
      url: "https://github.com/acme/web/pull/12",
      branch: "blazebot/aiw-100",
      isNew: true,
    });
    mocks.recordPublicationPullRequest.mockRejectedValue(new Error("database unavailable"));

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("failed");
    expect(publication.prs).toEqual([
      expect.objectContaining({ repoPath: "acme/web", id: 12 }),
    ]);
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
    expect(mocks.recordWorkflowOwnedPullRequest).not.toHaveBeenCalled();
  });

  it("repairs workflow-owned branch correlation for an already-recorded PR", async () => {
    const creating = attempt({
      status: "creating_prs",
      repositories: [
        repository("github", "acme/web", {
          pr: { id: 12, url: "https://github.com/acme/web/pull/12", isNew: true },
        }),
      ],
    });
    mocks.getPublicationAttempt
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce({ ...creating, status: "published" });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("published");
    expect(mocks.createOrFindWorkflowOwnedPullRequest).not.toHaveBeenCalled();
    expect(mocks.recordWorkflowOwnedPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ ticketKey: "AIW-100", pr: expect.objectContaining({ id: 12 }) }),
    );
  });
});
