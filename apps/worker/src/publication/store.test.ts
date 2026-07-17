import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import {
  createOrGetPublicationAttempt,
  failPublicationAttempt,
  getPublicationAttempt,
  markPublicationAttemptCreatingPrs,
  markPublicationAttemptFinalized,
  markPublicationAttemptPublished,
  recordPublicationPullRequest,
  recordPublicationRepositoryPreflight,
  recordPublicationRepositoryPush,
} from "./store.js";

describe("publication attempt store", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("creates one durable attempt per run/block and records exact push and PR results", async () => {
    const input = {
      runId: "run-1",
      blockId: "finalize",
      repositories: [
        {
          provider: "github" as const,
          repoPath: "acme/api",
          branchName: "aiw/AWT-1",
          defaultBranch: "main",
        },
      ],
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
      repositories: [
        { provider: "github", repoPath: "acme/web", branchName: "aiw/AWT-2", defaultBranch: "main" },
        { provider: "gitlab", repoPath: "acme/api", branchName: "aiw/AWT-2", defaultBranch: "main" },
      ],
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
        repositories: [{ ...repository, provider: "invalid" as "github" }],
      }),
    ).rejects.toThrow();

    const retry = await createOrGetPublicationAttempt(db, {
      runId: "run-3",
      blockId: "finalize",
      repositories: [repository],
    });
    expect(retry.created).toBe(true);
    expect(retry.attempt.repositories).toHaveLength(1);
  });
});
