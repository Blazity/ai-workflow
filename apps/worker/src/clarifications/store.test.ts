import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { activeRuns, clarificationRequests } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  ClarificationStoreError,
  answerClarification,
  completeClarificationCheckpoint,
  createClarificationCheckpoint,
  createClarificationRequest,
  getClarification,
  getClarificationForRun,
  getPendingForTicket,
  claimClarificationSnapshotCleanup,
  listClarificationSnapshotCleanup,
  listAnsweredForTicket,
  listPendingClarificationSubjectKeys,
  listUndispatchedAnsweredClarifications,
  markClarificationSnapshotCleanupFailed,
  markClarificationSnapshotDeleted,
  publishClarificationCheckpoint,
  recordDispatchedRun,
  reconcileClarificationCheckpoints,
  serializeClarification,
  setDispatchedRunId,
  supersedeClarification,
  supersedePendingForTicket,
} from "./store.js";

function seed(ticketKey = "AWT-1") {
  return {
    ticketKey,
    runId: "run-asked",
    blockId: "human_question_1",
    definitionId: 1,
    definitionVersion: 4,
    questions: ["Which environment?", "Ship behind a flag?"],
  };
}

function checkpointSeed(ticketKey = "AWT-1") {
  return {
    ticketKey,
    subjectKey: `ticket:jira:${ticketKey}`,
    ownerToken: "owner-parked",
    runId: "run-asked",
    waitingNodeId: "implementation",
    definitionId: 1,
    definitionVersionPin: 4 as const,
    triggerPayload: { status: "fired", ticketKey },
    priorSteps: {
      trigger: { output: { status: "fired", ticketKey } },
      prepare: { output: { status: "ready", sandboxId: "sbx-source" } },
    },
    budgetState: {
      activeElapsedMs: 60_000,
      tokensInput: 100,
      tokensCached: 10,
      tokensOutput: 20,
      tokensKnown: true,
      costNanos: 500_000_000,
      costUsd: 0.5,
      costKnown: true,
    },
    workspaceManifest: {
      version: 1 as const,
      repositories: [
        {
          provider: "github" as const,
          repoPath: "acme/api",
          slug: "acme__api",
          localPath: "/vercel/sandbox",
          defaultBranch: "main",
          branchName: "ai/AWT-1",
          selectedRationale: "ticket scope",
          preAgentSha: "abc123",
        },
      ],
    },
    sourceHeads: [{ provider: "github" as const, repoPath: "acme/api", sha: "abc123" }],
    expiresAt: new Date("2026-07-24T00:00:00.000Z"),
    questions: ["Which conflict side should win?"],
    suggestedAnswers: ["ours", "theirs"],
  };
}

describe("durable clarification checkpoints", () => {
  it("keeps a preparing checkpoint unpublished until its snapshot is durable", async () => {
    const db = await createTestDb();
    const draft = await createClarificationCheckpoint(db, checkpointSeed());

    expect(draft.status).toBe("superseded");
    expect(draft.checkpointState).toBe("preparing");
    expect(draft.subjectKey).toBe("ticket:jira:AWT-1");
    expect(draft.definitionVersionPin).toBe(4);
    expect(draft.waitingNodeId).toBe("implementation");
    expect(draft.priorSteps.prepare.output.sandboxId).toBe("sbx-source");
    expect(draft.budgetState.activeElapsedMs).toBe(60_000);
    expect(await getPendingForTicket(db, "AWT-1")).toBeNull();

    await expect(publishClarificationCheckpoint(db, draft.id)).rejects.toMatchObject({
      statusCode: 409,
      message: "clarification_checkpoint_not_ready",
    });

    const ready = await completeClarificationCheckpoint(db, draft.id, {
      snapshotId: "snap-1",
      sourceSandboxId: "sbx-source",
      expiresAt: new Date("2026-07-24T00:00:00.000Z"),
    });
    expect(ready.checkpointState).toBe("ready");
    expect(ready.cleanupState).toBe("retained");

    const published = await publishClarificationCheckpoint(db, draft.id);
    expect(published.row.status).toBe("pending");
    expect(published.row.publishedAt).toBeInstanceOf(Date);
    expect(published.supersededSnapshots).toEqual([]);
    expect((await getPendingForTicket(db, "AWT-1"))?.id).toBe(draft.id);
  });

  it("publishes a replacement before scheduling the old snapshot for deletion", async () => {
    const db = await createTestDb();
    const first = await createClarificationCheckpoint(db, checkpointSeed());
    await completeClarificationCheckpoint(db, first.id, {
      snapshotId: "snap-old",
      sourceSandboxId: "sbx-old",
      expiresAt: checkpointSeed().expiresAt,
    });
    await publishClarificationCheckpoint(db, first.id);

    const second = await createClarificationCheckpoint(db, {
      ...checkpointSeed(),
      runId: "run-second",
      ownerToken: "owner-second",
      questions: ["One more detail?"],
    });
    await completeClarificationCheckpoint(db, second.id, {
      snapshotId: "snap-new",
      sourceSandboxId: "sbx-new",
      expiresAt: checkpointSeed().expiresAt,
    });
    const result = await publishClarificationCheckpoint(db, second.id);

    expect(result.row.status).toBe("pending");
    expect(result.supersededSnapshots).toEqual(["snap-old"]);
    expect((await getClarification(db, first.id))?.cleanupState).toBe("delete_pending");
  });

  it("treats a reconciler-published checkpoint as an idempotent publish retry", async () => {
    const db = await createTestDb();
    const checkpoint = await createClarificationCheckpoint(
      db,
      checkpointSeed("AWT-12"),
    );
    await completeClarificationCheckpoint(db, checkpoint.id, {
      snapshotId: "snap-current",
      sourceSandboxId: "sbx-current",
      expiresAt: checkpointSeed().expiresAt,
    });

    const first = await publishClarificationCheckpoint(db, checkpoint.id);
    const retry = await publishClarificationCheckpoint(db, checkpoint.id);

    expect(first.row.status).toBe("pending");
    expect(retry.supersededSnapshots).toEqual([]);
    expect(retry.row).toMatchObject({
      status: "pending",
      cleanupState: "retained",
      snapshotId: "snap-current",
    });
  });

  it("rejects answers after checkpoint expiry with an actionable recovery error", async () => {
    const db = await createTestDb();
    const draft = await createClarificationCheckpoint(db, {
      ...checkpointSeed(),
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    await completeClarificationCheckpoint(db, draft.id, null);
    await publishClarificationCheckpoint(db, draft.id, new Date("2026-06-30T00:00:00.000Z"));

    await expect(
      answerClarification(db, {
        id: draft.id,
        answer: "ours",
        actor: { id: "u1", label: "Alice" },
        successorOwnerToken: "owner-successor",
        now: new Date("2026-07-02T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      statusCode: 410,
      message: expect.stringContaining("restart the ticket"),
    });
  });

  it("rejects an answer when the retained workspace snapshot has expired", async () => {
    const db = await createTestDb();
    const checkpoint = await createClarificationCheckpoint(
      db,
      checkpointSeed("AWT-14"),
    );
    await completeClarificationCheckpoint(db, checkpoint.id, {
      snapshotId: "snap-expired-before-checkpoint",
      sourceSandboxId: "sbx-source",
      expiresAt: new Date("2026-07-18T00:00:00.000Z"),
    });
    await publishClarificationCheckpoint(
      db,
      checkpoint.id,
      new Date("2026-07-17T00:00:00.000Z"),
    );

    await expect(
      answerClarification(db, {
        id: checkpoint.id,
        answer: "ours",
        actor: { id: "u1", label: "Alice" },
        successorOwnerToken: "owner-successor",
        now: new Date("2026-07-19T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      statusCode: 410,
      message: expect.stringContaining("restart the ticket"),
    });
  });

  it("expires orphaned parked checkpoints and returns their snapshots for cleanup", async () => {
    const db = await createTestDb();
    const liveInput = checkpointSeed("AWT-2");
    await db.insert(activeRuns).values({
      subjectKey: liveInput.subjectKey,
      ticketKey: liveInput.ticketKey,
      ownerToken: liveInput.ownerToken,
      runId: liveInput.runId,
      state: "bound",
    });
    const live = await createClarificationCheckpoint(db, liveInput);
    await completeClarificationCheckpoint(db, live.id, {
      snapshotId: "snap-live",
      sourceSandboxId: "sbx-live",
      expiresAt: liveInput.expiresAt,
    });
    await publishClarificationCheckpoint(db, live.id);

    const orphan = await createClarificationCheckpoint(db, checkpointSeed("AWT-3"));
    await completeClarificationCheckpoint(db, orphan.id, {
      snapshotId: "snap-orphan",
      sourceSandboxId: "sbx-orphan",
      expiresAt: checkpointSeed().expiresAt,
    });
    await publishClarificationCheckpoint(db, orphan.id);

    const work = await reconcileClarificationCheckpoints(
      db,
      new Date("2026-07-18T00:00:00.000Z"),
    );

    expect(work).toEqual([
      { clarificationId: orphan.id, snapshotId: "snap-orphan", reason: "orphaned" },
    ]);
    expect((await getClarification(db, orphan.id))?.checkpointState).toBe("orphaned");
    expect((await getClarification(db, orphan.id))?.status).toBe("superseded");
    expect((await getClarification(db, live.id))?.status).toBe("pending");
  });

  it("repairs a ready unpublished checkpoint while its exact predecessor is still bound", async () => {
    const db = await createTestDb();
    const input = checkpointSeed("AWT-9");
    await db.insert(activeRuns).values({
      subjectKey: input.subjectKey,
      ticketKey: input.ticketKey,
      ownerToken: input.ownerToken,
      runId: input.runId,
      state: "bound",
    });
    const checkpoint = await createClarificationCheckpoint(db, input);
    await completeClarificationCheckpoint(db, checkpoint.id, null);

    expect(await reconcileClarificationCheckpoints(
      db,
      new Date("2026-07-18T00:00:00.000Z"),
    )).toEqual([]);
    expect(await getClarification(db, checkpoint.id)).toMatchObject({
      status: "pending",
      checkpointState: "ready",
      publishedAt: expect.any(Date),
    });
  });

  it("retires a ready unpublished checkpoint whose predecessor disappeared", async () => {
    const db = await createTestDb();
    const checkpoint = await createClarificationCheckpoint(
      db,
      checkpointSeed("AWT-10"),
    );
    await completeClarificationCheckpoint(db, checkpoint.id, {
      snapshotId: "snap-unpublished",
      sourceSandboxId: "sbx-unpublished",
      expiresAt: checkpointSeed().expiresAt,
    });

    expect(await reconcileClarificationCheckpoints(
      db,
      new Date("2026-07-18T00:00:00.000Z"),
    )).toEqual([
      {
        clarificationId: checkpoint.id,
        snapshotId: "snap-unpublished",
        reason: "orphaned",
      },
    ]);
    expect(await getClarification(db, checkpoint.id)).toMatchObject({
      status: "superseded",
      checkpointState: "orphaned",
      cleanupState: "delete_pending",
    });
  });

  it("retires an abandoned preparing row instead of leaving stale application state", async () => {
    const db = await createTestDb();
    const checkpoint = await createClarificationCheckpoint(
      db,
      checkpointSeed("AWT-11"),
    );

    expect(await reconcileClarificationCheckpoints(
      db,
      new Date("2026-07-18T00:00:00.000Z"),
    )).toEqual([]);
    expect(await getClarification(db, checkpoint.id)).toMatchObject({
      status: "superseded",
      checkpointState: "orphaned",
      cleanupState: "deleted",
    });
  });

  it("lists only durable pending subjects for generic run reconciliation protection", async () => {
    const db = await createTestDb();
    const input = checkpointSeed("AWT-4");
    const durable = await createClarificationCheckpoint(db, input);
    await completeClarificationCheckpoint(db, durable.id, null);
    await publishClarificationCheckpoint(db, durable.id);
    await createClarificationRequest(db, seed("AWT-5"));

    expect(await listPendingClarificationSubjectKeys(db)).toEqual([
      input.subjectKey,
    ]);
  });

  it("lists unexpired answered checkpoints that still need successor dispatch", async () => {
    const db = await createTestDb();
    const input = {
      ...checkpointSeed("AWT-6"),
      workspaceManifest: null,
      sourceHeads: [],
    };
    const checkpoint = await createClarificationCheckpoint(db, input);
    await completeClarificationCheckpoint(db, checkpoint.id, null);
    await publishClarificationCheckpoint(
      db,
      checkpoint.id,
      new Date("2026-07-17T00:00:00.000Z"),
    );
    await answerClarification(db, {
      id: checkpoint.id,
      answer: "ours",
      actor: { id: "u1", label: "Alice" },
      successorOwnerToken: "owner-successor",
      now: new Date("2026-07-17T01:00:00.000Z"),
    });

    expect(
      await listUndispatchedAnsweredClarifications(
        db,
        new Date("2026-07-18T00:00:00.000Z"),
      ),
    ).toMatchObject([{ id: checkpoint.id, successorOwnerToken: "owner-successor" }]);

    await setDispatchedRunId(db, checkpoint.id, "run-resumed");
    expect(
      await listUndispatchedAnsweredClarifications(
        db,
        new Date("2026-07-18T00:00:00.000Z"),
      ),
    ).toEqual([]);
  });

  it("expires an answered checkpoint before successor recovery and queues its snapshot", async () => {
    const db = await createTestDb();
    const input = {
      ...checkpointSeed("AWT-7"),
      expiresAt: new Date("2026-07-18T00:00:00.000Z"),
    };
    const checkpoint = await createClarificationCheckpoint(db, input);
    await completeClarificationCheckpoint(db, checkpoint.id, {
      snapshotId: "snap-expired",
      sourceSandboxId: "sbx-expired",
      expiresAt: input.expiresAt,
    });
    await publishClarificationCheckpoint(
      db,
      checkpoint.id,
      new Date("2026-07-17T00:00:00.000Z"),
    );
    await answerClarification(db, {
      id: checkpoint.id,
      answer: "ours",
      actor: { id: "u1", label: "Alice" },
      successorOwnerToken: "owner-successor",
      now: new Date("2026-07-17T01:00:00.000Z"),
    });

    expect(
      await reconcileClarificationCheckpoints(
        db,
        new Date("2026-07-19T00:00:00.000Z"),
      ),
    ).toEqual([
      {
        clarificationId: checkpoint.id,
        snapshotId: "snap-expired",
        reason: "expired",
      },
    ]);
    expect(await listUndispatchedAnsweredClarifications(db)).toEqual([]);
    expect(await getClarification(db, checkpoint.id)).toMatchObject({
      status: "superseded",
      checkpointState: "expired",
      cleanupState: "delete_pending",
    });
  });

  it("claims each queued snapshot cleanup once and permits failed cleanup retry", async () => {
    const db = await createTestDb();
    const checkpoint = await createClarificationCheckpoint(
      db,
      checkpointSeed("AWT-8"),
    );
    await completeClarificationCheckpoint(db, checkpoint.id, {
      snapshotId: "snap-cleanup",
      sourceSandboxId: "sbx-cleanup",
      expiresAt: checkpointSeed().expiresAt,
    });
    await publishClarificationCheckpoint(db, checkpoint.id);
    await supersedeClarification(db, checkpoint.id);

    expect(await listClarificationSnapshotCleanup(db)).toEqual([
      { clarificationId: checkpoint.id, snapshotId: "snap-cleanup" },
    ]);
    expect(await claimClarificationSnapshotCleanup(db, checkpoint.id)).toBe(true);
    expect(await claimClarificationSnapshotCleanup(db, checkpoint.id)).toBe(false);
    expect(await listClarificationSnapshotCleanup(db)).toEqual([]);

    await markClarificationSnapshotCleanupFailed(db, checkpoint.id, "delete failed");
    expect(await listClarificationSnapshotCleanup(db)).toEqual([
      { clarificationId: checkpoint.id, snapshotId: "snap-cleanup" },
    ]);
    expect(await claimClarificationSnapshotCleanup(db, checkpoint.id)).toBe(true);
    expect(await markClarificationSnapshotDeleted(db, checkpoint.id)).toBe(true);
    expect(await listClarificationSnapshotCleanup(db)).toEqual([]);
  });

  it("converges concurrent cleanup success and failure bookkeeping on deleted", async () => {
    const db = await createTestDb();
    const checkpoint = await createClarificationCheckpoint(
      db,
      checkpointSeed("AWT-13"),
    );
    await completeClarificationCheckpoint(db, checkpoint.id, {
      snapshotId: "snap-race",
      sourceSandboxId: "sbx-race",
      expiresAt: checkpointSeed().expiresAt,
    });
    await publishClarificationCheckpoint(db, checkpoint.id);
    await supersedeClarification(db, checkpoint.id);
    await claimClarificationSnapshotCleanup(db, checkpoint.id);

    expect(await markClarificationSnapshotDeleted(db, checkpoint.id)).toBe(true);
    await markClarificationSnapshotCleanupFailed(db, checkpoint.id, "late loser");
    expect((await getClarification(db, checkpoint.id))?.cleanupState).toBe("deleted");

    await db
      .update(clarificationRequests)
      .set({ cleanupState: "failed" })
      .where(eq(clarificationRequests.id, checkpoint.id));
    expect(await markClarificationSnapshotDeleted(db, checkpoint.id)).toBe(true);
    expect((await getClarification(db, checkpoint.id))?.cleanupState).toBe("deleted");
  });
});

describe("createClarificationRequest", () => {
  it("inserts a pending row with the supplied questions and defaults", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    expect(row.status).toBe("pending");
    expect(row.questions).toEqual(["Which environment?", "Ship behind a flag?"]);
    expect(row.suggestedAnswers).toBeNull();
    expect(row.blockId).toBe("human_question_1");
    expect(row.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("stores suggested answers when supplied", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, {
      ...seed(),
      suggestedAnswers: ["staging", "yes"],
    });
    expect(row.suggestedAnswers).toEqual(["staging", "yes"]);
    const stored = await getClarification(db, row.id);
    expect(stored?.suggestedAnswers).toEqual(["staging", "yes"]);
  });

  it("tolerates a null definition (built-in default graph)", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, {
      ...seed(),
      blockId: null,
      definitionId: null,
      definitionVersion: null,
    });
    expect(row.blockId).toBeNull();
    expect(row.definitionId).toBeNull();
    expect(row.definitionVersion).toBeNull();
  });

  it("supersedes an existing pending row for the same ticket", async () => {
    const db = await createTestDb();
    const first = await createClarificationRequest(db, seed());
    const second = await createClarificationRequest(db, {
      ...seed(),
      questions: ["Second time around?"],
    });

    const firstAfter = await getClarification(db, first.id);
    expect(firstAfter?.status).toBe("superseded");
    expect(second.status).toBe("pending");
    expect(second.questions).toEqual(["Second time around?"]);

    const pending = await getPendingForTicket(db, "AWT-1");
    expect(pending?.id).toBe(second.id);
  });
});

describe("partial unique index", () => {
  it("cannot be violated through the store API", async () => {
    const db = await createTestDb();
    const first = await createClarificationRequest(db, seed());
    const second = await createClarificationRequest(db, seed());
    // Two creates for one ticket leave exactly one pending row (the first was
    // superseded first), so the store never trips the partial unique index.
    expect((await getClarification(db, first.id))?.status).toBe("superseded");
    expect(second.status).toBe("pending");
  });

  it("rejects a second raw pending row for the same ticket", async () => {
    const db = await createTestDb();
    await createClarificationRequest(db, seed());
    await expect(
      db.insert(clarificationRequests).values({
        id: randomUUID(),
        ticketKey: "AWT-1",
        runId: "run-other",
        questions: ["x"],
      }),
    ).rejects.toThrow();
  });
});

describe("answerClarification CAS", () => {
  it("transitions pending -> answered and records the actor", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    const answered = await answerClarification(db, {
      id: row.id,
      answer: "Use staging, ship behind a flag.",
      actor: { id: "u1", label: "Alice" },
    });
    expect(answered.status).toBe("answered");
    expect(answered.answer).toBe("Use staging, ship behind a flag.");
    expect(answered.answeredById).toBe("u1");
    expect(answered.answeredByLabel).toBe("Alice");
    expect(answered.answeredAt).toBeInstanceOf(Date);
  });

  it("throws 409 already_answered on a second answer", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    await answerClarification(db, { id: row.id, answer: "first", actor: { id: "u1", label: "Alice" } });
    await expect(
      answerClarification(db, { id: row.id, answer: "second", actor: { id: "u2", label: "Bob" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("throws for an unknown id", async () => {
    const db = await createTestDb();
    await expect(
      answerClarification(db, { id: "missing", answer: "x", actor: { id: "u1", label: "Alice" } }),
    ).rejects.toBeInstanceOf(ClarificationStoreError);
  });
});

describe("listAnsweredForTicket", () => {
  it("excludes pending and superseded rows", async () => {
    const db = await createTestDb();
    const answered = await mkAnswered(db, "AWT-1", new Date("2026-01-01T00:00:00Z"));
    // A superseded row plus a fresh pending row: creating twice supersedes the
    // first pending and leaves the second pending.
    const superseded = await createClarificationRequest(db, seed());
    await createClarificationRequest(db, seed());

    const history = await listAnsweredForTicket(db, "AWT-1");
    expect(history.map((r) => r.id)).toEqual([answered]);
    expect((await getClarification(db, superseded.id))?.status).toBe("superseded");
  });

  it("orders multiple answered rows oldest first", async () => {
    const db = await createTestDb();
    const early = await mkAnswered(db, "AWT-1", new Date("2026-01-01T00:00:00Z"));
    const late = await mkAnswered(db, "AWT-1", new Date("2026-02-01T00:00:00Z"));
    const history = await listAnsweredForTicket(db, "AWT-1");
    expect(history.map((r) => r.id)).toEqual([early, late]);
  });
});

describe("getClarificationForRun", () => {
  it("returns the latest clarification a run asked", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    const found = await getClarificationForRun(db, "run-asked");
    expect(found?.id).toBe(row.id);
  });

  it("returns null when the run asked nothing", async () => {
    const db = await createTestDb();
    expect(await getClarificationForRun(db, "run-none")).toBeNull();
  });
});

describe("supersedePendingForTicket", () => {
  it("supersedes the pending row and returns the count", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    const count = await supersedePendingForTicket(db, "AWT-1");
    expect(count).toBe(1);
    expect((await getClarification(db, row.id))?.status).toBe("superseded");
    expect(await getPendingForTicket(db, "AWT-1")).toBeNull();
  });

  it("returns 0 when there is nothing pending", async () => {
    const db = await createTestDb();
    expect(await supersedePendingForTicket(db, "AWT-1")).toBe(0);
  });
});

describe("supersedeClarification", () => {
  it("supersedes an answered, undispatched row by id", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    await answerClarification(db, { id: row.id, answer: "a", actor: { id: "u", label: "U" } });
    const count = await supersedeClarification(db, row.id);
    expect(count).toBe(1);
    expect((await getClarification(db, row.id))?.status).toBe("superseded");
  });

  it("refuses to supersede a row that already dispatched a resume run", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    await answerClarification(db, { id: row.id, answer: "a", actor: { id: "u", label: "U" } });
    await setDispatchedRunId(db, row.id, "run-resumed");
    const count = await supersedeClarification(db, row.id);
    expect(count).toBe(0);
    expect((await getClarification(db, row.id))?.status).toBe("answered");
  });
});

describe("setDispatchedRunId", () => {
  it("records the dispatched resume run", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    await setDispatchedRunId(db, row.id, "run-resumed");
    const after = await getClarification(db, row.id);
    expect(after?.dispatchedRunId).toBe("run-resumed");
  });
});

describe("recordDispatchedRun", () => {
  it("records the resume run when none is set", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    const wrote = await recordDispatchedRun(db, row.id, "run-self-heal");
    expect(wrote).toBe(true);
    expect((await getClarification(db, row.id))?.dispatchedRunId).toBe("run-self-heal");
  });

  it("does not overwrite an existing dispatched run", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    await setDispatchedRunId(db, row.id, "run-endpoint");
    const wrote = await recordDispatchedRun(db, row.id, "run-self-heal");
    expect(wrote).toBe(false);
    expect((await getClarification(db, row.id))?.dispatchedRunId).toBe("run-endpoint");
  });
});

describe("serializeClarification", () => {
  it("maps every field, rendering timestamps as ISO strings", async () => {
    const db = await createTestDb();
    const created = await createClarificationRequest(db, {
      ...seed(),
      suggestedAnswers: ["staging"],
    });
    const answered = await answerClarification(db, {
      id: created.id,
      answer: "Use staging.",
      actor: { id: "u1", label: "Alice" },
    });
    const dto = serializeClarification(answered);
    expect(dto).toMatchObject({
      id: answered.id,
      ticketKey: "AWT-1",
      runId: "run-asked",
      blockId: "human_question_1",
      definitionId: 1,
      definitionVersion: 4,
      questions: ["Which environment?", "Ship behind a flag?"],
      suggestedAnswers: ["staging"],
      status: "answered",
      answer: "Use staging.",
      answeredById: "u1",
      answeredByLabel: "Alice",
      dispatchedRunId: null,
    });
    expect(dto.askedAt).toBe(answered.askedAt.toISOString());
    expect(dto.answeredAt).toBe(answered.answeredAt!.toISOString());
  });

  it("renders answeredAt as null while pending", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    const dto = serializeClarification(row);
    expect(dto.answeredAt).toBeNull();
    expect(dto.answer).toBeNull();
  });
});

async function mkAt(db: Db, ticketKey: string, askedAt: Date): Promise<string> {
  const id = randomUUID();
  await db.insert(clarificationRequests).values({
    id,
    ticketKey,
    runId: "run-asked",
    questions: ["x"],
    askedAt,
  });
  return id;
}

async function mkAnswered(db: Db, ticketKey: string, askedAt: Date): Promise<string> {
  const id = await mkAt(db, ticketKey, askedAt);
  await answerClarification(db, { id, answer: "a", actor: { id: "u1", label: "Alice" } });
  return id;
}
