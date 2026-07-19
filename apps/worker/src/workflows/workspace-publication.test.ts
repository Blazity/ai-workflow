import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";

const mocks = vi.hoisted(() => ({
  publishTrustedWorkspaceFromSandbox: vi.fn(),
  findWorkflowOwnedPullRequestForBranch: vi.fn(),
  createOrFindWorkflowOwnedPullRequest: vi.fn(),
  recordWorkflowOwnedPullRequestIntent: vi.fn(),
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
  sleep: vi.fn(),
}));

vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  sleep: mocks.sleep,
}));

vi.mock("../sandbox/trusted-workspace-publisher.js", () => ({
  publishTrustedWorkspaceFromSandbox: mocks.publishTrustedWorkspaceFromSandbox,
}));
vi.mock("../sandbox/write-human-decisions-memory.js", () => ({
  writeHumanDecisionsMemory: mocks.writeHumanDecisionsMemory,
}));
vi.mock("./repository-prs.js", () => ({
  findWorkflowOwnedPullRequestForBranch: mocks.findWorkflowOwnedPullRequestForBranch,
  createOrFindWorkflowOwnedPullRequest: mocks.createOrFindWorkflowOwnedPullRequest,
  recordWorkflowOwnedPullRequestIntent: mocks.recordWorkflowOwnedPullRequestIntent,
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
  openPullRequestsForPublication as openPullRequestsForPublicationImpl,
} from "./workspace-publication.js";

function openPullRequestsForPublication(
  input: Omit<
    Parameters<typeof openPullRequestsForPublicationImpl>[0],
    "subjectKey" | "ownerToken"
  >,
  options?: Parameters<typeof openPullRequestsForPublicationImpl>[1],
) {
  return openPullRequestsForPublicationImpl(
    {
      ...input,
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
    },
    options,
  );
}

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

const workspaceManifest: WorkspaceManifest = {
  version: 1,
  repositories: selectedRepositories.map((repository, index) => ({
    ...repository,
    slug: repository.repoPath.replace("/", "__"),
    localPath: index === 0 ? "/vercel/sandbox" : `/vercel/sandbox/repos/repo-${index}`,
    branchName: "blazebot/aiw-100",
    expectedRemoteSha: `${repository.repoPath}-before`,
    preAgentSha: `${repository.repoPath}-before`,
  })),
};

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
    workspaceManifest,
    repositories: [
      repository("github", "acme/web"),
      repository("gitlab", "acme/api"),
    ],
    ...overrides,
  };
}

function serializedOwnerLoss(): Error {
  const error = new Error("Provider mutation requires the exact active run owner.");
  error.name = "ActiveRunOwnerError";
  return error;
}

describe("finalizeWorkspacePublication", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.sleep.mockResolvedValue(undefined);
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: true,
      attempt: attempt({ status: "preflighting" }),
    });
  });

  it("fails a stale triggering PR head before any git push", async () => {
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getPRHead: vi.fn().mockResolvedValue({
          headSha: "newer-provider-head",
          baseRef: "main",
          state: "open",
        }),
      },
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
      sourcePullRequest: {
        provider: "github",
        repoPath: "acme/web",
        prId: 12,
        headSha: "trigger-head",
        baseRef: "main",
      },
    });

    expect(publication).toEqual(
      expect.objectContaining({ status: "failed", attemptId: "attempt-1" }),
    );
    expect(publication.status === "failed" ? publication.reason : "").toContain(
      "newer-provider-head",
    );
    expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
    expect(mocks.recordPublicationRepositoryFailure).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/web", failure: expect.stringContaining("stale") }),
    );
    expect(mocks.failPublicationAttempt).toHaveBeenCalled();
  });

  it("fails a same-head triggering PR after its target branch changes", async () => {
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getPRHead: vi.fn().mockResolvedValue({
          headSha: "trigger-head",
          baseRef: "release",
          state: "open",
        }),
      },
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
      sourcePullRequest: {
        provider: "github",
        repoPath: "acme/web",
        prId: 12,
        headSha: "trigger-head",
        baseRef: "main",
      },
    });

    expect(publication.status).toBe("failed");
    expect(publication.status === "failed" ? publication.reason : "").toContain("release");
    expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
  });

  it.each(["closed", "merged"] as const)(
    "fails source remediation when the triggering PR is now %s",
    async (state) => {
      mocks.createRepositoryVcsRuntime.mockReturnValue({
        vcs: {
          getPRHead: vi.fn().mockResolvedValue({
            headSha: "trigger-head",
            baseRef: "main",
            state,
          }),
        },
      });

      const publication = await finalizeWorkspacePublication({
        runId: "run-1",
        subjectKey: "ticket:jira:AIW-100",
        ownerToken: "owner-1",
        blockId: "finalize",
        sandboxId: "sbx-1",
        ticketKey: "AIW-100",
        workspaceManifest,
        sourcePullRequest: {
          provider: "github",
          repoPath: "acme/web",
          prId: 12,
          headSha: "trigger-head",
          baseRef: "main",
        },
      });

      expect(publication.status).toBe("failed");
      expect(publication.status === "failed" ? publication.reason : "").toContain(state);
      expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
    },
  );

  it("passes source PR identity into the credentialed publisher boundary", async () => {
    const sourcePullRequest = {
      provider: "github" as const,
      repoPath: "acme/web",
      prId: 12,
      headSha: "trigger-head",
      baseRef: "main",
    };
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getPRHead: vi.fn().mockResolvedValue({
          headSha: "trigger-head",
          baseRef: "main",
          state: "open",
        }),
      },
    });
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
      sourcePullRequest,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.publishTrustedWorkspaceFromSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePullRequest }),
    );
  });

  it("rechecks source PR identity before resuming a durable partial push", async () => {
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: false,
      attempt: attempt({
        status: "pushing",
        repositories: [repository("github", "acme/web", { pushedHead: null })],
      }),
    });
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getBranchSha: vi.fn().mockResolvedValue("acme/web-before"),
        getPRHead: vi.fn().mockResolvedValue({
          headSha: "trigger-head",
          baseRef: "release",
          state: "open",
        }),
      },
    });
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
      pushed: true,
      repositories: [],
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
      sourcePullRequest: {
        provider: "github",
        repoPath: "acme/web",
        prId: 12,
        headSha: "trigger-head",
        baseRef: "main",
      },
    });

    expect(publication.status).toBe("failed");
    expect(publication.status === "failed" ? publication.reason : "").toContain("release");
    expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
  });

  it("records a cross-provider partial push durably and creates no PR", async () => {
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
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
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
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
    expect(mocks.publishTrustedWorkspaceFromSandbox).toHaveBeenCalledWith(
      {
        sourceSandboxId: "sbx-1",
        publicationAttemptId: "attempt-1",
        workspaceManifest,
        subjectKey: "ticket:jira:AIW-100",
        ownerToken: "owner-1",
        runId: "run-1",
      },
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
  });

  it("resumes an existing preflighting attempt instead of stranding it", async () => {
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: false,
      attempt: attempt({ status: "preflighting" }),
    });
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.markPublicationAttemptPushing).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
    );
    expect(mocks.publishTrustedWorkspaceFromSandbox).toHaveBeenCalledWith(
      {
        sourceSandboxId: "sbx-1",
        publicationAttemptId: "attempt-1",
        workspaceManifest,
        subjectKey: "ticket:jira:AIW-100",
        ownerToken: "owner-1",
        runId: "run-1",
      },
    );
  });

  it("replays Finalize successfully after Open PR has started", async () => {
    mocks.createOrGetPublicationAttempt.mockResolvedValue({
      created: false,
      attempt: attempt({ status: "creating_prs" }),
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
  });

  it("terminally records a publisher error after durable retries and reconciliation are exhausted", async () => {
    mocks.publishTrustedWorkspaceFromSandbox.mockRejectedValue(
      new Error("publication result could not be recorded"),
    );
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "pushing",
        repositories: [repository("github", "acme/web", { pushedHead: null })],
      }),
    );
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: { getBranchSha: vi.fn().mockResolvedValue("acme/web-before") },
    });

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
    });

    expect(publication).toEqual(
      expect.objectContaining({
        status: "failed",
        reason: expect.stringContaining("publication result could not be recorded"),
      }),
    );
    expect(mocks.markPublicationAttemptPushing).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
    );
    expect(mocks.failPublicationAttempt).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
      expect.stringContaining("retries exhausted"),
    );
  });

  it("rethrows exact-owner loss from trusted workspace publication", async () => {
    const ownerLoss = serializedOwnerLoss();
    mocks.publishTrustedWorkspaceFromSandbox.mockRejectedValue(ownerLoss);

    await expect(
      finalizeWorkspacePublication({
        runId: "run-1",
        subjectKey: "ticket:jira:AIW-100",
        ownerToken: "owner-1",
        blockId: "finalize",
        sandboxId: "sbx-1",
        ticketKey: "AIW-100",
        workspaceManifest,
      }),
    ).rejects.toBe(ownerLoss);

    expect(mocks.getPublicationAttempt).not.toHaveBeenCalled();
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("terminally records an exhausted publisher when loading reconciliation state also fails", async () => {
    mocks.publishTrustedWorkspaceFromSandbox.mockRejectedValue(
      new Error("publisher unavailable"),
    );
    mocks.getPublicationAttempt.mockRejectedValue(
      new Error("publication ledger unavailable"),
    );

    const publication = await finalizeWorkspacePublication({
      runId: "run-1",
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
    });

    expect(publication).toEqual(
      expect.objectContaining({
        status: "failed",
        reason: expect.stringContaining("publication ledger unavailable"),
      }),
    );
    expect(mocks.failPublicationAttempt).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
      expect.stringContaining("retries exhausted"),
    );
  });

  it("finalizes when reconciliation proves an interrupted push step already landed", async () => {
    mocks.publishTrustedWorkspaceFromSandbox.mockRejectedValue(
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
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

  it("finalizes when the push landed but recording its outcome exhausted retries", async () => {
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
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
    mocks.recordPublicationRepositoryPreflight.mockRejectedValue(
      new Error("publication outcome database unavailable"),
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
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
    expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
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
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.publishTrustedWorkspaceFromSandbox).toHaveBeenCalledWith(
      {
        sourceSandboxId: "sbx-1",
        publicationAttemptId: "attempt-1",
        workspaceManifest,
        subjectKey: "ticket:jira:AIW-100",
        ownerToken: "owner-1",
        runId: "run-1",
      },
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
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
    });

    expect(publication.status).toBe("finalized");
    expect(mocks.publishTrustedWorkspaceFromSandbox).toHaveBeenCalledTimes(1);
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

  it("terminally records provider head-read uncertainty after reconciliation retries exhaust", async () => {
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
    });

    expect(publication.status).toBe("failed");
    expect(publication.status === "failed" ? publication.reason : "").toContain(
      "provider unavailable",
    );
    expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
    expect(mocks.failPublicationAttempt).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
      expect.stringContaining("provider unavailable"),
    );
    expect(mocks.markPublicationAttemptFinalized).not.toHaveBeenCalled();
  });

  it("continues Finalize when the durable publisher step returns its recovered success", async () => {
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
    });

    expect(publication).toEqual(
      expect.objectContaining({ status: "finalized", attemptId: "attempt-1" }),
    );
    expect(mocks.markPublicationAttemptFinalized).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
    );
  });

  it("preserves human-decision memory writing before the push", async () => {
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
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
      subjectKey: "ticket:jira:AIW-100",
      ownerToken: "owner-1",
      blockId: "finalize",
      sandboxId: "sbx-1",
      ticketKey: "AIW-100",
      workspaceManifest,
      clarifications,
    });

    expect(mocks.writeHumanDecisionsMemory).toHaveBeenCalledWith(
      "sbx-1",
      "AIW-100",
      clarifications,
    );
    expect(mocks.writeHumanDecisionsMemory.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publishTrustedWorkspaceFromSandbox.mock.invocationCallOrder[0],
    );
  });
});

describe("openPullRequestsForPublication", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.sleep.mockResolvedValue(undefined);
    mocks.recordPublicationPullRequest.mockReset().mockResolvedValue(undefined);
    mocks.recordWorkflowOwnedPullRequest.mockReset().mockResolvedValue(undefined);
    mocks.findWorkflowOwnedPullRequestForBranch.mockResolvedValue(null);
    mocks.createRepositoryVcsRuntime.mockImplementation(
      ({ repoPath }: { repoPath: string }) => ({
        vcs: {
          getBranchSha: vi.fn().mockResolvedValue(`${repoPath}-after`),
          getPRHeadSha: vi.fn().mockResolvedValue(`${repoPath}-after`),
          getPRHead: vi.fn().mockResolvedValue({
            headSha: `${repoPath}-after`,
            baseRef: "main",
            state: "open",
          }),
        },
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
    expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
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

  it("fails closed instead of replacing a source PR closed after Finalize", async () => {
    const finalized = attempt({
      status: "finalized",
      repositories: [repository("github", "acme/web")],
    });
    mocks.getPublicationAttempt
      .mockResolvedValueOnce(finalized)
      .mockResolvedValueOnce({
        ...finalized,
        status: "published",
        repositories: [
          repository("github", "acme/web", {
            pr: { id: 99, url: "https://github.com/acme/web/pull/99", isNew: true },
          }),
        ],
      });
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getBranchSha: vi.fn().mockResolvedValue("acme/web-after"),
        getPRHeadSha: vi.fn().mockResolvedValue("acme/web-after"),
        getPRHead: vi.fn().mockResolvedValue({
          headSha: "acme/web-after",
          baseRef: "main",
          state: "closed",
        }),
      },
    });
    mocks.createOrFindWorkflowOwnedPullRequest.mockResolvedValue({
      provider: "github",
      repoPath: "acme/web",
      id: 99,
      url: "https://github.com/acme/web/pull/99",
      branch: "blazebot/aiw-100",
      isNew: true,
    });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
      sourcePullRequest: {
        provider: "github",
        repoPath: "acme/web",
        prId: 7,
        headSha: "trigger-head",
        baseRef: "main",
      },
    });

    expect(publication.status).toBe("failed");
    expect(publication.status === "failed" ? publication.reason : "").toContain("closed");
    expect(mocks.createOrFindWorkflowOwnedPullRequest).not.toHaveBeenCalled();
  });

  it.each([
    { baseRef: "main", state: "closed" as const, expectedReason: "closed" },
    { baseRef: "release", state: "open" as const, expectedReason: "release" },
  ])(
    "fails a persisted non-source PR whose provider lifecycle changed: $expectedReason",
    async ({ baseRef, state, expectedReason }) => {
      const creating = attempt({
        status: "creating_prs",
        repositories: [
          repository("github", "acme/web", {
            pr: {
              id: 12,
              url: "https://github.com/acme/web/pull/12",
              isNew: true,
            },
          }),
        ],
      });
      mocks.getPublicationAttempt
        .mockResolvedValueOnce(creating)
        .mockResolvedValueOnce({ ...creating, status: "published" });
      mocks.createRepositoryVcsRuntime.mockReturnValue({
        vcs: {
          getBranchSha: vi.fn().mockResolvedValue("acme/web-after"),
          getPRHeadSha: vi.fn().mockResolvedValue("acme/web-after"),
          getPRHead: vi.fn().mockResolvedValue({
            headSha: "acme/web-after",
            baseRef,
            state,
          }),
        },
      });

      const publication = await openPullRequestsForPublication({
        attemptId: "attempt-1",
        runId: "run-1",
        ticketKey: "AIW-100",
        title: "Safe publication",
      });

      expect(publication.status).toBe("failed");
      expect(publication.status === "failed" ? publication.reason : "").toContain(
        expectedReason,
      );
      expect(mocks.failPublicationAttempt).toHaveBeenCalledWith(
        { db: true },
        "attempt-1",
        expect.stringContaining(expectedReason),
      );
      expect(mocks.markPublicationAttemptPublished).not.toHaveBeenCalled();
    },
  );

  it("revalidates and reuses the exact source PR at its post-push head", async () => {
    const finalized = attempt({
      status: "finalized",
      repositories: [repository("github", "acme/web")],
    });
    const source = {
      provider: "github" as const,
      repoPath: "acme/web",
      id: 7,
      url: "https://github.com/acme/web/pull/7",
      branch: "blazebot/aiw-100",
      isNew: false,
    };
    mocks.getPublicationAttempt
      .mockResolvedValueOnce(finalized)
      .mockResolvedValueOnce({
        ...finalized,
        status: "published",
        repositories: [
          repository("github", "acme/web", {
            pr: { id: 7, url: source.url, isNew: false },
          }),
        ],
      });
    const getPRHead = vi.fn().mockResolvedValue({
      headSha: "acme/web-after",
      baseRef: "main",
      state: "open",
    });
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getBranchSha: vi.fn().mockResolvedValue("acme/web-after"),
        getPRHeadSha: vi.fn().mockResolvedValue("acme/web-after"),
        getPRHead,
      },
    });
    mocks.findWorkflowOwnedPullRequestForBranch.mockResolvedValue(source);

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
      sourcePullRequest: {
        provider: "github",
        repoPath: "acme/web",
        prId: 7,
        headSha: "trigger-head",
        baseRef: "main",
      },
    });

    expect(publication.status).toBe("published");
    expect(getPRHead).toHaveBeenCalledWith(7);
    expect(mocks.createOrFindWorkflowOwnedPullRequest).not.toHaveBeenCalled();
    expect(mocks.recordPublicationPullRequest).toHaveBeenCalledWith(
      { db: true },
      {
        attemptId: "attempt-1",
        provider: "github",
        repoPath: "acme/web",
        pr: { id: 7, url: source.url, isNew: false },
      },
    );
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
    expect(publication.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "github",
          repoPath: "acme/web",
          defaultBranch: "main",
          pushedHead: "acme/web-after",
        }),
      ]),
    );
    expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
    expect(mocks.recordWorkflowOwnedPullRequestIntent).toHaveBeenCalledTimes(2);
    expect(mocks.createOrFindWorkflowOwnedPullRequest).toHaveBeenCalledTimes(2);
    expect(mocks.createOrFindWorkflowOwnedPullRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        owner: {
          subjectKey: "ticket:jira:AIW-100",
          ownerToken: "owner-1",
          runId: "run-1",
        },
      }),
    );
    expect(mocks.createOrFindWorkflowOwnedPullRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        owner: {
          subjectKey: "ticket:jira:AIW-100",
          ownerToken: "owner-1",
          runId: "run-1",
        },
      }),
    );
    expect(mocks.recordPublicationPullRequest).toHaveBeenCalledTimes(2);
    expect(mocks.recordWorkflowOwnedPullRequest).toHaveBeenCalledTimes(2);
    expect(mocks.recordPublicationPullRequest.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordWorkflowOwnedPullRequest.mock.invocationCallOrder[0],
    );
    expect(mocks.recordPublicationPullRequest.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.recordWorkflowOwnedPullRequest.mock.invocationCallOrder[1],
    );
    expect(mocks.recordWorkflowOwnedPullRequestIntent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createOrFindWorkflowOwnedPullRequest.mock.invocationCallOrder[0],
    );
    expect(mocks.recordWorkflowOwnedPullRequestIntent).toHaveBeenNthCalledWith(1, {
      ticketKey: "AIW-100",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-100",
      publishedHeadSha: "acme/web-after",
      targetBranch: "main",
    });
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
    expect(mocks.failPublicationAttempt).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
      expect.stringContaining("newer-head"),
    );
  });

  it("refuses to record a newly-created PR whose authoritative head moved", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "finalized",
        repositories: [repository("github", "acme/web")],
      }),
    );
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getBranchSha: vi.fn().mockResolvedValue("acme/web-after"),
        getPRHead: vi.fn().mockResolvedValue({
          headSha: "newer-pr-head",
          baseRef: "main",
          state: "open",
        }),
      },
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
      "newer-pr-head",
    );
    expect(mocks.recordPublicationPullRequest).toHaveBeenCalledOnce();
    expect(mocks.recordWorkflowOwnedPullRequest).not.toHaveBeenCalled();
    expect(mocks.markPublicationAttemptPublished).not.toHaveBeenCalled();
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

  it("durably retries an ambiguous provider creation failure and reconciles the created PR", async () => {
    const finalized = attempt({ status: "finalized" });
    const creating = attempt({
      status: "creating_prs",
      repositories: [
        repository("github", "acme/web", {
          pr: { id: 12, url: "https://github.com/acme/web/pull/12", isNew: true },
        }),
        repository("gitlab", "acme/api"),
      ],
    });
    mocks.getPublicationAttempt
      .mockResolvedValueOnce(finalized)
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce({
        ...creating,
        status: "published",
        repositories: [
          creating.repositories[0],
          repository("gitlab", "acme/api", {
            pr: {
              id: 13,
              url: "https://gitlab.com/acme/api/-/merge_requests/13",
              isNew: false,
            },
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
      .mockRejectedValueOnce(new Error("provider timed out after accepting create"))
      .mockResolvedValueOnce({
        provider: "gitlab",
        repoPath: "acme/api",
        id: 13,
        url: "https://gitlab.com/acme/api/-/merge_requests/13",
        branch: "blazebot/aiw-100",
        isNew: false,
      });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("published");
    expect(publication.prs).toHaveLength(2);
    expect(mocks.sleep).toHaveBeenCalledWith("5s");
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("keeps creating_prs durable across transient branch and intent reads", async () => {
    const creating = attempt({
      status: "creating_prs",
      repositories: [repository("github", "acme/web")],
    });
    mocks.getPublicationAttempt
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce({
        ...creating,
        status: "published",
        repositories: [
          repository("github", "acme/web", {
            pr: { id: 12, url: "https://github.com/acme/web/pull/12", isNew: false },
          }),
        ],
      });
    const getBranchSha = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider branch read unavailable"))
      .mockResolvedValue("acme/web-after");
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getBranchSha,
        getPRHead: vi.fn().mockResolvedValue({
          headSha: "acme/web-after",
          baseRef: "main",
          state: "open",
        }),
      },
    });
    mocks.recordWorkflowOwnedPullRequestIntent.mockRejectedValueOnce(
      new Error("intent database unavailable"),
    );
    mocks.createOrFindWorkflowOwnedPullRequest.mockResolvedValue({
      provider: "github",
      repoPath: "acme/web",
      id: 12,
      url: "https://github.com/acme/web/pull/12",
      branch: "blazebot/aiw-100",
      isNew: false,
    });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("published");
    expect(mocks.sleep).toHaveBeenNthCalledWith(1, "5s");
    expect(mocks.sleep).toHaveBeenNthCalledWith(2, "10s");
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("stops durable publication recovery at the run duration budget", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "creating_prs",
        repositories: [repository("github", "acme/web")],
      }),
    );
    mocks.createOrFindWorkflowOwnedPullRequest.mockRejectedValue(
      new Error("provider unavailable"),
    );
    const observeBudget = vi.fn().mockResolvedValue({
      check: { status: "ok" },
      remainingDurationMs: 4_000,
      durationLimitMs: 60_000,
      activeElapsedMs: 56_000,
    });

    await expect(
      openPullRequestsForPublication(
        {
          attemptId: "attempt-1",
          runId: "run-1",
          ticketKey: "AIW-100",
          title: "Safe publication",
        },
        { observeBudget },
      ),
    ).rejects.toThrow(/budget_exceeded/);
    expect(mocks.sleep).not.toHaveBeenCalled();
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("lets workflow cancellation interrupt a publication recovery sleep", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "creating_prs",
        repositories: [repository("github", "acme/web")],
      }),
    );
    mocks.createOrFindWorkflowOwnedPullRequest.mockRejectedValue(
      new Error("provider unavailable"),
    );
    mocks.sleep.mockRejectedValueOnce(new Error("workflow cancelled"));

    await expect(
      openPullRequestsForPublication({
        attemptId: "attempt-1",
        runId: "run-1",
        ticketKey: "AIW-100",
        title: "Safe publication",
      }),
    ).rejects.toThrow("workflow cancelled");
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("terminally records a deterministic provider FatalError", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "creating_prs",
        repositories: [repository("github", "acme/web")],
      }),
    );
    const fatal = new Error("repository permissions reject pull requests");
    fatal.name = "FatalError";
    mocks.createOrFindWorkflowOwnedPullRequest.mockRejectedValue(fatal);

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("failed");
    expect(mocks.sleep).not.toHaveBeenCalled();
    expect(mocks.failPublicationAttempt).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
      "repository permissions reject pull requests",
    );
  });

  it("rethrows exact-owner loss from provider PR creation", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "creating_prs",
        repositories: [repository("github", "acme/web")],
      }),
    );
    const ownerLoss = serializedOwnerLoss();
    mocks.createOrFindWorkflowOwnedPullRequest.mockRejectedValue(ownerLoss);
    mocks.sleep.mockRejectedValue(new Error("run control entered recovery backoff"));

    await expect(
      openPullRequestsForPublication({
        attemptId: "attempt-1",
        runId: "run-1",
        ticketKey: "AIW-100",
        title: "Safe publication",
      }),
    ).rejects.toBe(ownerLoss);

    expect(mocks.sleep).not.toHaveBeenCalled();
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("terminally records deterministic branch-read failures without backoff", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "creating_prs",
        repositories: [repository("gitlab", "acme/api")],
      }),
    );
    const fatal = new Error("branch not found");
    fatal.name = "FatalError";
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: { getBranchSha: vi.fn().mockRejectedValue(fatal) },
    });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication).toMatchObject({ status: "failed", reason: "branch not found" });
    expect(mocks.sleep).not.toHaveBeenCalled();
    expect(mocks.failPublicationAttempt).toHaveBeenCalled();
  });

  it("terminally records deterministic PR-head failures without backoff", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "creating_prs",
        repositories: [
          repository("gitlab", "acme/api", {
            pr: {
              id: 12,
              url: "https://gitlab.com/acme/api/-/merge_requests/12",
              isNew: true,
            },
          }),
        ],
      }),
    );
    const fatal = new Error("merge request not found");
    fatal.name = "FatalError";
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getBranchSha: vi.fn().mockResolvedValue("acme/api-after"),
        getPRHead: vi.fn().mockRejectedValue(fatal),
      },
    });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication).toMatchObject({
      status: "failed",
      reason: "merge request not found",
    });
    expect(mocks.sleep).not.toHaveBeenCalled();
    expect(mocks.failPublicationAttempt).toHaveBeenCalled();
  });

  it.each([
    { "retry-after": "60" },
    { "x-ratelimit-remaining": "0" },
  ])("keeps a Forbidden GitHub 403 rate-limit response recoverable: %o", async (headers) => {
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
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce({ ...creating, status: "published" });
    const rateLimited = Object.assign(new Error("Forbidden"), {
      status: 403,
      response: { headers },
    });
    const getBranchSha = vi
      .fn()
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce("acme/web-after");
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getBranchSha,
        getPRHead: vi.fn().mockResolvedValue({
          headSha: "acme/web-after",
          baseRef: "main",
          state: "open",
        }),
      },
    });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("published");
    expect(mocks.sleep).toHaveBeenCalledWith("5s");
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it.each([429, 503])("keeps provider %i failures recoverable", async (status) => {
    const creating = attempt({
      status: "creating_prs",
      repositories: [repository("github", "acme/web")],
    });
    mocks.getPublicationAttempt
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce({
        ...creating,
        status: "published",
        repositories: [
          repository("github", "acme/web", {
            pr: { id: 12, url: "https://github.com/acme/web/pull/12", isNew: true },
          }),
        ],
      });
    const retryable = Object.assign(new Error(`provider ${status}`), { status });
    mocks.createOrFindWorkflowOwnedPullRequest
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce({
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

    expect(publication.status).toBe("published");
    expect(mocks.sleep).toHaveBeenCalledWith("5s");
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("treats an ordinary provider 403 as deterministic", async () => {
    mocks.getPublicationAttempt.mockResolvedValue(
      attempt({
        status: "creating_prs",
        repositories: [repository("github", "acme/web")],
      }),
    );
    mocks.createOrFindWorkflowOwnedPullRequest.mockRejectedValue(
      Object.assign(new Error("Forbidden by repository policy"), { status: 403 }),
    );

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication).toMatchObject({
      status: "failed",
      reason: "Forbidden by repository policy",
    });
    expect(mocks.sleep).not.toHaveBeenCalled();
  });

  it("journals a reconciled provider PR before a later branch-move rejection", async () => {
    const creating = attempt({
      status: "creating_prs",
      repositories: [repository("github", "acme/web")],
    });
    const providerPr = {
      provider: "github" as const,
      repoPath: "acme/web",
      id: 12,
      url: "https://github.com/acme/web/pull/12",
      branch: "blazebot/aiw-100",
      isNew: false,
    };
    mocks.getPublicationAttempt.mockResolvedValue(creating);
    mocks.findWorkflowOwnedPullRequestForBranch
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(providerPr);
    mocks.createOrFindWorkflowOwnedPullRequest.mockResolvedValue({
      ...providerPr,
      isNew: true,
    });
    mocks.recordPublicationPullRequest
      .mockRejectedValueOnce(new Error("ledger unavailable"))
      .mockResolvedValueOnce(undefined);
    const getBranchSha = vi
      .fn()
      .mockResolvedValueOnce("acme/web-after")
      .mockResolvedValueOnce("human-moved-head");
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: { getBranchSha, getPRHeadSha: vi.fn() },
    });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("finalized branch moved"),
      prs: [expect.objectContaining({ id: 12, isNew: false })],
    });
    expect(mocks.sleep).toHaveBeenCalledWith("5s");
    expect(mocks.createOrFindWorkflowOwnedPullRequest).toHaveBeenCalledOnce();
    expect(mocks.recordPublicationPullRequest).toHaveBeenCalledTimes(2);
    expect(mocks.recordPublicationPullRequest.mock.invocationCallOrder[1]).toBeLessThan(
      getBranchSha.mock.invocationCallOrder[1],
    );
    expect(mocks.recordWorkflowOwnedPullRequest).not.toHaveBeenCalled();
  });

  it("keeps PR creation recoverable when the provider result cannot be recorded after retries", async () => {
    const creating = attempt({
      status: "creating_prs",
      repositories: [repository("github", "acme/web")],
    });
    mocks.getPublicationAttempt
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce({
        ...creating,
        status: "published",
        repositories: [
          repository("github", "acme/web", {
            pr: { id: 12, url: "https://github.com/acme/web/pull/12", isNew: true },
          }),
        ],
      });
    mocks.createOrFindWorkflowOwnedPullRequest.mockResolvedValue({
      provider: "github",
      repoPath: "acme/web",
      id: 12,
      url: "https://github.com/acme/web/pull/12",
      branch: "blazebot/aiw-100",
      isNew: true,
    });
    mocks.recordPublicationPullRequest.mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("published");
    expect(mocks.sleep).toHaveBeenCalledWith("5s");
    expect(mocks.recordPublicationRepositoryFailure).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        attemptId: "attempt-1",
        repoPath: "acme/web",
        failure: "database unavailable",
      }),
    );
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
    expect(mocks.recordWorkflowOwnedPullRequest).toHaveBeenCalledOnce();
  });

  it("keeps a ledger-recorded PR recoverable when ownership correlation exhausts retries", async () => {
    const creating = attempt({
      status: "creating_prs",
      repositories: [repository("github", "acme/web")],
    });
    const creatingWithPr = {
      ...creating,
      repositories: [
        repository("github", "acme/web", {
          pr: { id: 12, url: "https://github.com/acme/web/pull/12", isNew: true },
        }),
      ],
    };
    mocks.getPublicationAttempt
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce(creatingWithPr)
      .mockResolvedValueOnce({ ...creatingWithPr, status: "published" });
    mocks.createOrFindWorkflowOwnedPullRequest.mockResolvedValue({
      provider: "github",
      repoPath: "acme/web",
      id: 12,
      url: "https://github.com/acme/web/pull/12",
      branch: "blazebot/aiw-100",
      isNew: true,
    });
    mocks.recordWorkflowOwnedPullRequest.mockRejectedValueOnce(
      new Error("ownership database unavailable"),
    );

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("published");
    expect(mocks.sleep).toHaveBeenCalledWith("5s");
    expect(mocks.recordPublicationPullRequest).toHaveBeenCalledOnce();
    expect(mocks.recordPublicationRepositoryFailure).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        attemptId: "attempt-1",
        repoPath: "acme/web",
        failure: "ownership database unavailable",
      }),
    );
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
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

  it("durably retries an ambiguous final published-ledger write", async () => {
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
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce({ ...creating, status: "published" });
    mocks.markPublicationAttemptPublished
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("published");
    expect(mocks.sleep).toHaveBeenCalledWith("5s");
    expect(mocks.failPublicationAttempt).not.toHaveBeenCalled();
  });

  it("never reports published when the reloaded ledger concurrently became failed", async () => {
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
      .mockResolvedValueOnce({
        ...creating,
        status: "failed",
        failure: "concurrent publication failed",
      });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication).toMatchObject({
      status: "failed",
      reason: "concurrent publication failed",
    });
  });

  it("refuses to correlate a replayed PR whose authoritative head moved", async () => {
    const creating = attempt({
      status: "creating_prs",
      repositories: [
        repository("github", "acme/web", {
          pr: { id: 12, url: "https://github.com/acme/web/pull/12", isNew: true },
        }),
      ],
    });
    mocks.getPublicationAttempt.mockResolvedValue(creating);
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getBranchSha: vi.fn().mockResolvedValue("acme/web-after"),
        getPRHead: vi.fn().mockResolvedValue({
          headSha: "newer-pr-head",
          baseRef: "main",
          state: "open",
        }),
      },
    });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("failed");
    expect(publication.status === "failed" ? publication.reason : "").toContain(
      "newer-pr-head",
    );
    expect(mocks.createOrFindWorkflowOwnedPullRequest).not.toHaveBeenCalled();
    expect(mocks.recordPublicationPullRequest).not.toHaveBeenCalled();
    expect(mocks.recordWorkflowOwnedPullRequest).not.toHaveBeenCalled();
    expect(mocks.markPublicationAttemptPublished).not.toHaveBeenCalled();
  });

  it("terminally rejects a replayed PR when its finalized branch moved", async () => {
    const creating = attempt({
      status: "creating_prs",
      repositories: [
        repository("github", "acme/web", {
          pr: { id: 12, url: "https://github.com/acme/web/pull/12", isNew: true },
        }),
      ],
    });
    mocks.getPublicationAttempt.mockResolvedValue(creating);
    mocks.createRepositoryVcsRuntime.mockReturnValue({
      vcs: {
        getBranchSha: vi.fn().mockResolvedValue("newer-branch-head"),
        getPRHeadSha: vi.fn().mockResolvedValue("acme/web-after"),
      },
    });

    const publication = await openPullRequestsForPublication({
      attemptId: "attempt-1",
      runId: "run-1",
      ticketKey: "AIW-100",
      title: "Safe publication",
    });

    expect(publication.status).toBe("failed");
    expect(mocks.failPublicationAttempt).toHaveBeenCalledWith(
      { db: true },
      "attempt-1",
      expect.stringContaining("finalized branch moved"),
    );
  });
});
