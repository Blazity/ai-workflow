import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import {
  createOrGetPublicationAttempt,
  failPublicationAttempt,
  getPublicationAttempt,
  markPublicationAttemptCreatingPrs,
  markPublicationAttemptFinalized,
  markPublicationAttemptPushing,
  markPublicationAttemptPublished,
  recordPublicationPullRequest,
  recordPublicationRepositoryFailure,
  recordPublicationRepositoryPreflight,
  recordPublicationRepositoryPush,
} from "./store.js";
import type { WorkspaceManifest, WorkspaceRepo } from "../sandbox/repo-workspace.js";

const trustedManifest = {
  version: 1 as const,
  repositories: [{
    provider: "github" as const,
    repoPath: "acme/api",
    slug: "acme__api",
    localPath: "/vercel/sandbox",
    defaultBranch: "main",
    branchName: "aiw/AWT-1",
    selectedRationale: "selected",
    expectedRemoteSha: "remote-before",
    preAgentSha: "pre-agent",
  }],
};

function manifestFor(
  repositories: Array<
    Pick<WorkspaceRepo, "provider" | "repoPath" | "branchName" | "defaultBranch"> &
      Partial<WorkspaceRepo>
  >,
): WorkspaceManifest {
  return {
    version: 1,
    repositories: repositories.map((repository, index) => ({
      provider: repository.provider,
      repoPath: repository.repoPath,
      slug: repository.slug ?? `repo-${index}`,
      localPath: repository.localPath ?? `/vercel/sandbox/repo-${index}`,
      defaultBranch: repository.defaultBranch,
      branchName: repository.branchName,
      selectedRationale: repository.selectedRationale ?? "selected",
      expectedRemoteSha: repository.expectedRemoteSha ?? `remote-${index}`,
      preAgentSha: repository.preAgentSha ?? `pre-agent-${index}`,
    })),
  };
}

describe("publication attempt store", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("creates one durable attempt per run/block and records exact push and PR results", async () => {
    const input = {
      runId: "run-1",
      blockId: "finalize",
      workspaceManifest: manifestFor([
        {
          provider: "github" as const,
          repoPath: "acme/api",
          branchName: "aiw/AWT-1",
          defaultBranch: "main",
        },
      ]),
    };

    const first = await createOrGetPublicationAttempt(db, input);
    const replay = await createOrGetPublicationAttempt(db, input);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.attempt.id).toBe(first.attempt.id);

    await recordPublicationRepositoryPreflight(db, {
      attemptId: first.attempt.id,
      provider: "github",
      repoPath: "acme/api",
      changed: true,
      expectedHead: "remote-before",
      targetHead: "local-after",
    });
    await recordPublicationRepositoryPush(db, {
      attemptId: first.attempt.id,
      provider: "github",
      repoPath: "acme/api",
      pushedHead: "local-after",
    });
    await markPublicationAttemptPushing(db, first.attempt.id);
    await markPublicationAttemptFinalized(db, first.attempt.id);
    await markPublicationAttemptCreatingPrs(db, first.attempt.id);
    await recordPublicationPullRequest(db, {
      attemptId: first.attempt.id,
      provider: "github",
      repoPath: "acme/api",
      pr: { id: 17, url: "https://github.com/acme/api/pull/17", isNew: true },
    });
    await markPublicationAttemptPublished(db, first.attempt.id);

    await expect(getPublicationAttempt(db, first.attempt.id)).resolves.toEqual(
      expect.objectContaining({
        id: first.attempt.id,
        runId: "run-1",
        blockId: "finalize",
        status: "published",
        failure: null,
        repositories: [
          expect.objectContaining({
            provider: "github",
            repoPath: "acme/api",
            branchName: "aiw/AWT-1",
            defaultBranch: "main",
            changed: true,
            expectedHead: "remote-before",
            targetHead: "local-after",
            pushedHead: "local-after",
            pr: {
              id: 17,
              url: "https://github.com/acme/api/pull/17",
              isNew: true,
            },
            failure: null,
          }),
        ],
      }),
    );
  });

  it("retains successful repository pushes when a later repository fails", async () => {
    const { attempt } = await createOrGetPublicationAttempt(db, {
      runId: "run-2",
      blockId: "finalize",
      workspaceManifest: manifestFor([
        { provider: "github", repoPath: "acme/web", branchName: "aiw/AWT-2", defaultBranch: "main" },
        { provider: "gitlab", repoPath: "acme/api", branchName: "aiw/AWT-2", defaultBranch: "main" },
      ]),
    });
    await recordPublicationRepositoryPreflight(db, {
      attemptId: attempt.id,
      provider: "github",
      repoPath: "acme/web",
      changed: true,
      expectedHead: "web-before",
    });
    await recordPublicationRepositoryPush(db, {
      attemptId: attempt.id,
      provider: "github",
      repoPath: "acme/web",
      pushedHead: "web-after",
    });
    await recordPublicationRepositoryPreflight(db, {
      attemptId: attempt.id,
      provider: "gitlab",
      repoPath: "acme/api",
      changed: true,
      expectedHead: "api-before",
      failure: "lease rejected",
    });
    await failPublicationAttempt(db, attempt.id, "gitlab:acme/api: lease rejected");

    const stored = await getPublicationAttempt(db, attempt.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.failure).toContain("lease rejected");
    expect(stored?.repositories).toEqual([
      expect.objectContaining({ repoPath: "acme/web", pushedHead: "web-after" }),
      expect.objectContaining({ repoPath: "acme/api", failure: "lease rejected" }),
    ]);
    expect(stored?.repositories.every((repo) => repo.pr === null)).toBe(true);
  });

  it("rolls back the parent attempt when repository initialization fails", async () => {
    const repository = {
      provider: "github" as const,
      repoPath: "acme/api",
      branchName: "aiw/AWT-3",
      defaultBranch: "main",
    };

    await expect(
      createOrGetPublicationAttempt(db, {
        runId: "run-3",
        blockId: "finalize",
        workspaceManifest: manifestFor([{ ...repository, provider: "invalid" as "github" }]),
      } as Parameters<typeof createOrGetPublicationAttempt>[1]),
    ).rejects.toThrow();

    const retry = await createOrGetPublicationAttempt(db, {
      runId: "run-3",
      blockId: "finalize",
      workspaceManifest: manifestFor([repository]),
    });
    expect(retry.created).toBe(true);
    expect(retry.attempt.repositories).toHaveLength(1);
  });

  it("does not let stale callbacks regress a published attempt", async () => {
    const { attempt } = await createOrGetPublicationAttempt(db, {
      runId: "run-published",
      blockId: "finalize",
      workspaceManifest: manifestFor([]),
    });
    await markPublicationAttemptPushing(db, attempt.id);
    await markPublicationAttemptFinalized(db, attempt.id);
    await markPublicationAttemptCreatingPrs(db, attempt.id);
    await markPublicationAttemptPublished(db, attempt.id);

    await markPublicationAttemptCreatingPrs(db, attempt.id);
    await failPublicationAttempt(db, attempt.id, "late stale failure");

    await expect(getPublicationAttempt(db, attempt.id)).resolves.toMatchObject({
      status: "published",
      failure: null,
    });
  });

  it("accepts only immediate forward state transitions and keeps failure terminal", async () => {
    const { attempt } = await createOrGetPublicationAttempt(db, {
      runId: "run-cas",
      blockId: "finalize",
      workspaceManifest: manifestFor([]),
    });

    await markPublicationAttemptPublished(db, attempt.id);
    await markPublicationAttemptFinalized(db, attempt.id);
    await expect(getPublicationAttempt(db, attempt.id)).resolves.toMatchObject({
      status: "preflighting",
    });

    await markPublicationAttemptPushing(db, attempt.id);
    await failPublicationAttempt(db, attempt.id, "known push failure");
    await markPublicationAttemptFinalized(db, attempt.id);
    await expect(getPublicationAttempt(db, attempt.id)).resolves.toMatchObject({
      status: "failed",
      failure: "known push failure",
    });
  });

  it("rejects a replay whose trusted manifest no longer exactly matches the ledger", async () => {
    const input = {
      runId: "run-trusted",
      blockId: "finalize",
      workspaceManifest: trustedManifest,
    };
    await createOrGetPublicationAttempt(db, input);

    await expect(createOrGetPublicationAttempt(db, {
      ...input,
      workspaceManifest: {
        ...trustedManifest,
        repositories: [{ ...trustedManifest.repositories[0], branchName: "main" }],
      },
    })).rejects.toThrow(/trusted workspace manifest/i);
  });

  it("fails loudly instead of silently updating a missing attempt or repository", async () => {
    await expect(markPublicationAttemptPushing(db, "missing-attempt")).rejects.toThrow(
      /missing-attempt/,
    );
    await expect(recordPublicationRepositoryFailure(db, {
      attemptId: "missing-attempt",
      provider: "github",
      repoPath: "acme/api",
      failure: "boom",
    })).rejects.toThrow(/missing-attempt.*github:acme\/api/);
  });
});
