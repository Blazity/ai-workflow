import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  activeRuns,
  clarificationRequests,
  ticketTransitionIntents,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
import {
  beginTicketTransitionIntent,
  consumeTicketTransitionIntent,
  discardTicketTransitionIntent,
  finishTicketTransitionIntent,
  getTicketCancellationFence,
  getTicketMutationVersion,
  listPotentialLateTicketTransitionTargets,
  recordTicketCancellationFence,
  recordTicketCancellationFenceOwner,
  recordTicketTransitionIntent,
  recordStartedParkedTicketTransitionIntent,
  recordStartedTicketReconciliationIntent,
} from "./ticket-transition-intent-store.js";

let db: Db;

const subjectKey = "ticket:jira:AIW-101";
const ticketKey = "AIW-101";

beforeEach(async () => {
  db = await createTestDb();
});

async function insertOwner(input: {
  ownerToken: string;
  runId: string | null;
  state: "reserved" | "bound" | "parking" | "parked" | "cancelling";
}): Promise<void> {
  await db.insert(activeRuns).values({
    subjectKey,
    ticketKey,
    ownerToken: input.ownerToken,
    runId: input.runId,
    state: input.state,
    runKind: "ticket",
    ticketCancellationReconciledVersion:
      input.state === "cancelling" ? -1 : null,
  });
}

function intentOwner(ownerToken: string, runId: string | null) {
  return {
    ticketKey,
    subjectKey,
    ownerToken,
    runId,
    actorAccountId: "jira-bot-account",
  };
}

function echo(webhookIdentifier = "jira-delivery-1", actorAccountId = "jira-bot-account") {
  return { webhookIdentifier, actorAccountId };
}

describe("ticket transition intents", () => {
  it("records intent for the exact reserved owner with a null run id", async () => {
    await insertOwner({ ownerToken: "owner-reserved", runId: null, state: "reserved" });

    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-reserved", null),
      target: { name: "AI", statusId: "10010" },
    });

    expect(await db.select().from(ticketTransitionIntents)).toEqual([
      expect.objectContaining({
        subjectKey,
        ownerToken: "owner-reserved",
        runId: null,
        actorAccountId: "jira-bot-account",
        targetStatusId: "10010",
      }),
    ]);
  });

  it("retains workflow echoes for at least Jira's full retry window", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const before = Date.now();

    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "Done",
    });

    const [intent] = await db.select().from(ticketTransitionIntents);
    expect(intent.expiresAt.getTime() - before).toBeGreaterThanOrEqual(75 * 60 * 1000);
  });

  it("records intent for the exact bound owner and run", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });

    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "Backlog",
    });

    expect(await db.select().from(ticketTransitionIntents)).toEqual([
      expect.objectContaining({ ownerToken: "owner-bound", runId: "run-1" }),
    ]);
  });

  it("atomically marks provider start only while the exact owner is still open", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const intentId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "Backlog",
    });

    await expect(
      beginTicketTransitionIntent(db, intentId, {
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
      }),
    ).resolves.toBe(true);
    expect(
      (await db.select().from(ticketTransitionIntents))[0]?.providerStartedAt,
    ).toBeInstanceOf(Date);
    expect((await db.select().from(activeRuns))[0]?.ticketMutationVersion).toBe(1);
    expect((await db.select().from(activeRuns))[0]?.ticketProviderCallsInFlight).toBe(1);

    await db
      .update(activeRuns)
      .set({ state: "cancelling", ticketCancellationReconciledVersion: -1 })
      .where(eq(activeRuns.subjectKey, subjectKey));
    const secondIntentId = await db
      .insert(ticketTransitionIntents)
      .values({
        ticketKey,
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
        actorAccountId: "jira-bot-account",
        targetStatusName: "Done",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: ticketTransitionIntents.id })
      .then(([row]) => row!.id);
    await expect(
      beginTicketTransitionIntent(db, secondIntentId, {
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
      }),
    ).resolves.toBe(false);
  });

  it("serializes provider start against cancellation without an unmarked provider boundary", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const intentId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "Backlog",
    });
    const registry = new PostgresRunRegistry(db);

    const [started, cancelled] = await Promise.all([
      beginTicketTransitionIntent(db, intentId, {
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
      }),
      registry.beginCancellation(subjectKey, "owner-bound", "run-1"),
    ]);

    expect(cancelled).toBe(true);
    const [intent] = await db.select().from(ticketTransitionIntents);
    const [owner] = await db.select().from(activeRuns);
    expect(owner).toMatchObject({ state: "cancelling" });
    expect(intent?.providerStartedAt instanceof Date).toBe(started);
    expect(owner?.ticketMutationVersion).toBe(started ? 1 : 0);
  });

  it("atomically starts clarification recovery only under the exact parked owner", async () => {
    await insertOwner({ ownerToken: "owner-parked", runId: "run-1", state: "parked" });

    await expect(
      recordStartedParkedTicketTransitionIntent(db, {
        ...intentOwner("owner-parked", "run-1"),
        runId: "run-1",
        target: "Backlog",
      }),
    ).resolves.toEqual(expect.any(Number));

    expect(await db.select().from(ticketTransitionIntents)).toEqual([
      expect.objectContaining({
        ownerToken: "owner-parked",
        runId: "run-1",
        providerStartedAt: expect.any(Date),
      }),
    ]);
    expect((await db.select().from(activeRuns))[0]).toMatchObject({
      state: "parked",
      ticketMutationVersion: 1,
      ticketProviderCallsInFlight: 1,
    });
  });

  it("serializes parked clarification recovery against cancellation", async () => {
    await insertOwner({ ownerToken: "owner-parked", runId: "run-1", state: "parked" });
    const registry = new PostgresRunRegistry(db);

    const [started, cancelled] = await Promise.allSettled([
      recordStartedParkedTicketTransitionIntent(db, {
        ...intentOwner("owner-parked", "run-1"),
        runId: "run-1",
        target: "Backlog",
      }),
      registry.beginCancellation(subjectKey, "owner-parked", "run-1"),
    ]);

    expect(cancelled).toMatchObject({ status: "fulfilled", value: true });
    const [active] = await db.select().from(activeRuns);
    expect(active?.state).toBe("cancelling");
    if (started.status === "fulfilled") {
      expect(active?.ticketProviderCallsInFlight).toBe(1);
      expect(active?.ticketMutationVersion).toBe(1);
    } else {
      expect(started.reason).toMatchObject({
        message: expect.stringMatching(/exact parked owner/i),
      });
      expect(active?.ticketProviderCallsInFlight).toBe(0);
      expect(active?.ticketMutationVersion).toBe(0);
    }
  });

  it("lets only one overlapping poll open an unfinished parked recovery", async () => {
    await insertOwner({ ownerToken: "owner-parked", runId: "run-1", state: "parked" });
    const input = {
      ...intentOwner("owner-parked", "run-1"),
      runId: "run-1",
      target: "Backlog" as const,
    };

    const attempts = await Promise.allSettled([
      recordStartedParkedTicketTransitionIntent(db, input),
      recordStartedParkedTicketTransitionIntent(db, input),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(ticketTransitionIntents)).toHaveLength(1);
    expect((await db.select().from(activeRuns))[0]).toMatchObject({
      ticketProviderCallsInFlight: 1,
      ticketMutationVersion: 1,
    });
  });

  it("marks the exact started intent finished", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const intentId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "Backlog",
    });
    await beginTicketTransitionIntent(db, intentId, {
      subjectKey,
      ownerToken: "owner-bound",
      runId: "run-1",
    });

    await expect(finishTicketTransitionIntent(db, intentId)).resolves.toBe(true);
    expect(
      (await db.select().from(ticketTransitionIntents))[0]?.providerFinishedAt,
    ).toBeInstanceOf(Date);
    expect((await db.select().from(activeRuns))[0]?.ticketProviderCallsInFlight).toBe(0);
  });

  it("stores each human destination durably and selects the newest event for the owner", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const first = new Date("2026-07-18T12:00:00.000Z");
    const second = new Date("2026-07-18T12:00:01.000Z");

    await expect(
      recordTicketCancellationFence(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
        target: { name: "Backlog", statusId: "10001" },
        webhookIdentifier: "human-move-1",
        occurredAt: first,
      }),
    ).resolves.toBe(true);
    await expect(
      recordTicketCancellationFence(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
        target: { name: "Blocked", statusId: "10030" },
        webhookIdentifier: "human-move-2",
        occurredAt: second,
      }),
    ).resolves.toBe(true);
    // A retry of the older delivery must not become the desired destination.
    await recordTicketCancellationFence(db, {
      ticketKey,
      subjectKey,
      ownerToken: "owner-bound",
      runId: "run-1",
      target: { name: "Backlog", statusId: "10001" },
      webhookIdentifier: "human-move-1",
      occurredAt: first,
    });

    await expect(
      getTicketCancellationFence(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        target: { name: "Blocked", statusId: "10030" },
        occurredAt: second,
      }),
    );
  });

  it("atomically closes a reserved owner with its human fence before it can bind", async () => {
    await insertOwner({ ownerToken: "owner-reserved", runId: null, state: "reserved" });
    const registry = new PostgresRunRegistry(db);

    await expect(
      recordTicketCancellationFence(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-reserved",
        runId: null,
        target: "Backlog",
        webhookIdentifier: "reserved-human-move",
        occurredAt: new Date(),
      }),
    ).resolves.toBe(true);

    expect(await registry.get(subjectKey)).toMatchObject({
      state: "cancelling",
      runId: null,
    });
    await expect(
      registry.bindRun(subjectKey, "owner-reserved", "run-too-late"),
    ).resolves.toBe(false);
  });

  it("atomically closes a parked owner with its human fence before clarification handoff", async () => {
    await insertOwner({ ownerToken: "owner-parked", runId: "run-1", state: "parked" });
    const registry = new PostgresRunRegistry(db);

    await expect(
      recordTicketCancellationFence(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-parked",
        runId: "run-1",
        target: "Backlog",
        webhookIdentifier: "parked-human-move",
        occurredAt: new Date(),
      }),
    ).resolves.toBe(true);

    expect(await registry.get(subjectKey)).toMatchObject({ state: "cancelling" });
    await expect(
      registry.handoffBoundRun(
        subjectKey,
        "owner-parked",
        "run-1",
        "owner-successor",
      ),
    ).resolves.toBe(false);
  });

  it("follows only the clarification-authorized successor when handoff wins the human fence race", async () => {
    await insertOwner({ ownerToken: "owner-parked", runId: "run-1", state: "parked" });
    await db.insert(clarificationRequests).values({
      id: "clarification-1",
      ticketKey,
      runId: "run-1",
      questions: ["Which approach?"],
      status: "answered",
      subjectKey,
      ownerToken: "owner-parked",
      checkpointState: "ready",
      successorOwnerToken: "owner-successor",
    });
    const registry = new PostgresRunRegistry(db);
    await expect(
      registry.handoffBoundRun(
        subjectKey,
        "owner-parked",
        "run-1",
        "owner-successor",
      ),
    ).resolves.toBe(true);

    await expect(
      recordTicketCancellationFenceOwner(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-parked",
        runId: "run-1",
        target: "Backlog",
        webhookIdentifier: "handoff-human-move",
        occurredAt: new Date(),
      }),
    ).resolves.toEqual({ ownerToken: "owner-successor", runId: null });

    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-successor",
      runId: null,
      state: "cancelling",
    });
    await expect(
      getTicketCancellationFence(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-successor",
        runId: null,
      }),
    ).resolves.toMatchObject({ target: "Backlog" });
  });

  it("does not attach a human fence to an unrelated replacement owner", async () => {
    await insertOwner({ ownerToken: "owner-parked", runId: "run-1", state: "parked" });
    await db.insert(clarificationRequests).values({
      id: "clarification-unrelated",
      ticketKey,
      runId: "run-1",
      questions: ["Which approach?"],
      status: "answered",
      subjectKey,
      ownerToken: "owner-parked",
      checkpointState: "ready",
      successorOwnerToken: "owner-authorized",
    });
    const registry = new PostgresRunRegistry(db);
    await registry.handoffBoundRun(
      subjectKey,
      "owner-parked",
      "run-1",
      "owner-unrelated",
    );

    await expect(
      recordTicketCancellationFence(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-parked",
        runId: "run-1",
        target: "Backlog",
        webhookIdentifier: "unrelated-human-move",
        occurredAt: new Date(),
      }),
    ).resolves.toBe(false);
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-unrelated",
      state: "reserved",
    });
  });

  it("records a restoration echo only under the exact cancelling owner", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "cancelling" });

    await expect(
      recordStartedTicketReconciliationIntent(db, {
        ...intentOwner("owner-bound", "run-1"),
        target: { name: "Backlog", statusId: "10001" },
      }),
    ).resolves.toEqual(expect.any(Number));
    const [intent] = await db.select().from(ticketTransitionIntents);
    expect(intent).toEqual(
      expect.objectContaining({
        targetStatusId: "10001",
        providerStartedAt: expect.any(Date),
      }),
    );
    await expect(
      getTicketMutationVersion(db, {
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
      }),
    ).resolves.toBe(1);
  });

  it("returns only provider calls that may have completed after the human move", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const beforeId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "AI", statusId: "10010" },
    });
    const lateId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "AI Review", statusId: "10020" },
    });
    const unfinishedId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10040" },
    });
    const humanMove = new Date("2026-07-18T12:00:00.000Z");
    await db
      .update(ticketTransitionIntents)
      .set({
        providerStartedAt: new Date("2026-07-18T11:59:58.000Z"),
        providerFinishedAt: new Date("2026-07-18T11:59:59.000Z"),
      })
      .where(eq(ticketTransitionIntents.id, beforeId));
    await db
      .update(ticketTransitionIntents)
      .set({
        providerStartedAt: new Date("2026-07-18T11:59:59.000Z"),
        providerFinishedAt: new Date("2026-07-18T12:00:01.000Z"),
      })
      .where(eq(ticketTransitionIntents.id, lateId));
    await db
      .update(ticketTransitionIntents)
      .set({ providerStartedAt: new Date("2026-07-18T11:59:59.500Z") })
      .where(eq(ticketTransitionIntents.id, unfinishedId));

    await expect(
      listPotentialLateTicketTransitionTargets(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
        finishedAfter: humanMove,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: lateId,
        target: { name: "AI Review", statusId: "10020" },
      }),
      expect.objectContaining({
        id: unfinishedId,
        target: { name: "Done", statusId: "10040" },
        providerFinishedAt: null,
      }),
    ]);
  });

  it("retains expired reconciliation evidence while its exact owner is still cancelling", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "cancelling" });
    const expiredAt = new Date(Date.now() - 60_000);
    await db.insert(ticketTransitionIntents).values({
      ticketKey,
      subjectKey,
      ownerToken: "owner-bound",
      runId: "run-1",
      actorAccountId: "jira-bot-account",
      targetStatusId: "10020",
      targetStatusName: "AI Review",
      providerStartedAt: new Date(Date.now() - 120_000),
      expiresAt: expiredAt,
    });
    await recordTicketCancellationFence(db, {
      ticketKey,
      subjectKey,
      ownerToken: "owner-bound",
      runId: "run-1",
      target: { name: "Backlog", statusId: "10001" },
      webhookIdentifier: "expired-human-move",
      occurredAt: new Date(Date.now() - 90_000),
      ttlMs: -1,
    });

    await expect(
      getTicketCancellationFence(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
      }),
    ).resolves.not.toBeNull();
    await expect(
      listPotentialLateTicketTransitionTargets(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
        finishedAfter: new Date(Date.now() - 90_000),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        target: { name: "AI Review", statusId: "10020" },
        providerFinishedAt: null,
      }),
    ]);

    await db
      .update(ticketTransitionIntents)
      .set({ providerFinishedAt: new Date() })
      .where(eq(ticketTransitionIntents.subjectKey, subjectKey));
    const fence = await getTicketCancellationFence(db, {
      ticketKey,
      subjectKey,
      ownerToken: "owner-bound",
      runId: "run-1",
    });
    const mutationVersion = await getTicketMutationVersion(db, {
      subjectKey,
      ownerToken: "owner-bound",
      runId: "run-1",
    });
    await expect(
      new PostgresRunRegistry(db).releaseCancellation(
        subjectKey,
        "owner-bound",
        "run-1",
        { latestFenceId: fence!.id, mutationVersion },
      ),
    ).resolves.toBe(true);
    await expect(
      getTicketCancellationFence(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
      }),
    ).resolves.toBeNull();
  });

  it("keeps expired finished transition evidence while its exact owner is cancelling", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "cancelling" });
    const evidenceId = await db
      .insert(ticketTransitionIntents)
      .values({
        ticketKey,
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
        actorAccountId: "jira-bot-account",
        targetStatusId: "10020",
        targetStatusName: "AI Review",
        providerStartedAt: new Date("2026-07-18T11:59:59.000Z"),
        providerFinishedAt: new Date("2026-07-18T12:00:01.000Z"),
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: ticketTransitionIntents.id })
      .then(([row]) => row!.id);

    // Opening the compensating provider boundary runs ordinary expiry cleanup.
    // That cleanup must retain the prior workflow destination until this exact
    // cancelling owner is released.
    await recordStartedTicketReconciliationIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Backlog", statusId: "10001" },
    });
    await expect(
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "does-not-match", name: "Other" },
        echo("unrelated-delivery"),
      ),
    ).resolves.toBe(false);
    await expect(
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10020", name: "AI Review" },
        echo("late-workflow-delivery"),
      ),
    ).resolves.toBe(true);

    await expect(
      listPotentialLateTicketTransitionTargets(db, {
        ticketKey,
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
        finishedAfter: new Date("2026-07-18T12:00:00.000Z"),
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: evidenceId,
          target: { name: "AI Review", statusId: "10020" },
          providerFinishedAt: new Date("2026-07-18T12:00:01.000Z"),
        }),
      ]),
    );
    await expect(
      db
        .select({ id: ticketTransitionIntents.id })
        .from(ticketTransitionIntents)
        .where(eq(ticketTransitionIntents.id, evidenceId)),
    ).resolves.toEqual([{ id: evidenceId }]);
  });

  it("rejects the wrong owner, wrong run, and reserved owner paired with a run id", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });

    await expect(
      recordTicketTransitionIntent(db, {
        ...intentOwner("owner-other", "run-1"),
        target: "Backlog",
      }),
    ).rejects.toThrow(/exact current owner/);
    await expect(
      recordTicketTransitionIntent(db, {
        ...intentOwner("owner-bound", "run-other"),
        target: "Backlog",
      }),
    ).rejects.toThrow(/exact current owner/);

    await db.delete(activeRuns).where(eq(activeRuns.subjectKey, subjectKey));
    await insertOwner({ ownerToken: "owner-reserved", runId: null, state: "reserved" });
    await expect(
      recordTicketTransitionIntent(db, {
        ...intentOwner("owner-reserved", "run-not-bound"),
        target: "AI",
      }),
    ).rejects.toThrow(/exact current owner/);
  });

  it("consumes a matching intent after its owner row is released", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });
    await db.delete(activeRuns).where(eq(activeRuns.subjectKey, subjectKey));

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
  });

  it("retains finished evidence through owner release and extends it on delayed echo consumption", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const intentId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });
    await beginTicketTransitionIntent(db, intentId, {
      subjectKey,
      ownerToken: "owner-bound",
      runId: "run-1",
    });
    await db
      .update(ticketTransitionIntents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(ticketTransitionIntents.id, intentId));

    await expect(finishTicketTransitionIntent(db, intentId)).resolves.toBe(true);
    const [finished] = await db
      .select()
      .from(ticketTransitionIntents)
      .where(eq(ticketTransitionIntents.id, intentId));
    expect(finished!.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      29 * 24 * 60 * 60 * 1000,
    );

    const registry = new PostgresRunRegistry(db);
    await expect(
      registry.beginCancellation(subjectKey, "owner-bound", "run-1"),
    ).resolves.toBe(true);
    const mutationVersion = await getTicketMutationVersion(db, {
      subjectKey,
      ownerToken: "owner-bound",
      runId: "run-1",
    });
    await expect(
      registry.releaseCancellation(subjectKey, "owner-bound", "run-1", {
        latestFenceId: null,
        mutationVersion,
      }),
    ).resolves.toBe(true);

    await expect(
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10042", name: "Done" },
        echo("delayed-after-release"),
      ),
    ).resolves.toBe(true);
    await db
      .update(ticketTransitionIntents)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(ticketTransitionIntents.id, intentId));
    await expect(
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10042", name: "Done" },
        echo("delayed-after-release"),
      ),
    ).resolves.toBe(true);

    const [retained] = await db
      .select()
      .from(ticketTransitionIntents)
      .where(eq(ticketTransitionIntents.id, intentId));
    expect(retained).toMatchObject({
      providerFinishedAt: expect.any(Date),
      consumedAt: expect.any(Date),
      webhookIdentifier: "delayed-after-release",
    });
    expect(retained!.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      29 * 24 * 60 * 60 * 1000,
    );
  });

  it("uses a consumed legacy echo as completion proof and decrements the owner fence", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await db.insert(ticketTransitionIntents).values({
      ticketKey,
      subjectKey,
      ownerToken: "owner-bound",
      runId: "run-1",
      actorAccountId: "jira-bot-account",
      targetStatusId: "10042",
      targetStatusName: "Done",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await db.select().from(activeRuns))[0]).toMatchObject({
      ticketMutationVersion: 1,
      ticketProviderCallsInFlight: 1,
    });

    await expect(
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10042", name: "Done" },
        echo("legacy-provider-echo"),
      ),
    ).resolves.toBe(true);

    expect((await db.select().from(ticketTransitionIntents))[0]).toMatchObject({
      consumedAt: expect.any(Date),
      providerFinishedAt: expect.any(Date),
    });
    expect((await db.select().from(activeRuns))[0]?.ticketProviderCallsInFlight).toBe(0);
  });

  it("uses an exact bot echo as positive proof for an expired ambiguous call", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const intentId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });
    await beginTicketTransitionIntent(db, intentId, {
      subjectKey,
      ownerToken: "owner-bound",
      runId: "run-1",
    });
    await db
      .update(ticketTransitionIntents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(ticketTransitionIntents.id, intentId));
    await new PostgresRunRegistry(db).beginCancellation(
      subjectKey,
      "owner-bound",
      "run-1",
    );

    await expect(
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10042", name: "Done" },
        echo("expired-ambiguous-bot-echo"),
      ),
    ).resolves.toBe(true);

    const [intent] = await db
      .select()
      .from(ticketTransitionIntents)
      .where(eq(ticketTransitionIntents.id, intentId));
    expect(intent).toMatchObject({
      consumedAt: expect.any(Date),
      providerFinishedAt: expect.any(Date),
      webhookIdentifier: "expired-ambiguous-bot-echo",
    });
    expect(intent!.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      29 * 24 * 60 * 60 * 1000,
    );
    expect((await db.select().from(activeRuns))[0]?.ticketProviderCallsInFlight).toBe(0);
  });

  it("survives reservation handoff after recording", async () => {
    await insertOwner({ ownerToken: "owner-first", runId: null, state: "reserved" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-first", null),
      target: { name: "AI", statusId: "10010" },
    });
    await db
      .update(activeRuns)
      .set({ ownerToken: "owner-successor" })
      .where(eq(activeRuns.subjectKey, subjectKey));

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10010", name: "AI" }, echo()),
    ).resolves.toBe(true);
  });

  it("suppresses concurrent retries of the same webhook idempotently", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });

    const results = await Promise.all([
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ]);

    expect(results).toEqual([true, true]);
  });

  it("lets only one of two concurrent delivery identities consume the intent", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });

    const results = await Promise.all([
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10042", name: "Done" },
        echo("jira-delivery-1"),
      ),
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10042", name: "Done" },
        echo("jira-delivery-2"),
      ),
    ]);

    expect(results.sort()).toEqual([false, true]);
  });

  it("suppresses a later retry after its intent was consumed", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
  });

  it("requires the exact workflow actor before consuming an intent", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });

    await expect(
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10042", name: "Done" },
        echo("jira-human-delivery", "human-account"),
      ),
    ).resolves.toBe(false);
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
  });

  it("consumes the oldest matching unconsumed intent first", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const olderId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "AI Review",
    });
    const newerId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "AI Review",
    });
    await db
      .update(ticketTransitionIntents)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(ticketTransitionIntents.id, olderId));
    await db
      .update(ticketTransitionIntents)
      .set({ createdAt: new Date("2026-01-02T00:00:00Z") })
      .where(eq(ticketTransitionIntents.id, newerId));

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { name: "ai review" }, echo()),
    ).resolves.toBe(true);

    const rows = await db
      .select()
      .from(ticketTransitionIntents)
      .orderBy(ticketTransitionIntents.id);
    expect(rows.find(({ id }) => id === olderId)?.consumedAt).toBeInstanceOf(Date);
    expect(rows.find(({ id }) => id === newerId)?.consumedAt).toBeNull();
  });

  it("discards only the intent with the exact id", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const discardedId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "AI Review",
    });
    const retainedId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "AI Review",
    });

    await expect(discardTicketTransitionIntent(db, discardedId)).resolves.toBe(true);
    await expect(discardTicketTransitionIntent(db, discardedId)).resolves.toBe(false);
    expect(await db.select().from(ticketTransitionIntents)).toEqual([
      expect.objectContaining({ id: retainedId }),
    ]);
  });

  it("matches a legacy configured destination by status name", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "AI Review", transitionId: "31" },
    });

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10010", name: "AI Review" }, echo()),
    ).resolves.toBe(true);
  });

  it("requires matching provider ids when both intent and webhook have one", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "99999", name: "Done" }, echo()),
    ).resolves.toBe(false);
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Renamed Done" }, echo()),
    ).resolves.toBe(true);
  });

  it("does not consume mismatched or expired unstarted intents and replays the same delivery", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
      ttlMs: -1,
    });
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(false);

    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "99999", name: "Backlog" }, echo()),
    ).resolves.toBe(false);
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
  });
});
