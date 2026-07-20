import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import {
  activeRunSandboxes,
  activeRuns,
  clarificationRequests,
  ticketCancellationFences,
  ticketLabelMutationIntents,
  ticketTransitionIntents,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { ActiveRunOwnerError } from "../../lib/run-control-errors.js";
import { PostgresRunRegistry } from "./postgres.js";
import { RESERVATION_BIND_GRACE_MS } from "./types.js";

let db: Db;
let registry: PostgresRunRegistry;

beforeEach(
  async () => {
    db = await createTestDb();
    registry = new PostgresRunRegistry(db);
  },
  30_000,
);

const subjectKey = "ticket:jira:PROJ-1";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("owner-CAS run claims", () => {
  it("reserves an unclaimed subject without pretending a workflow is bound", async () => {
    expect(
      await registry.reserve({
        subjectKey,
        ticketKey: "PROJ-1",
        ownerToken: "owner-a",
        kind: "ticket",
      }),
    ).toBe(true);

    expect(await registry.get(subjectKey)).toMatchObject({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      runId: null,
      state: "reserved",
      kind: "ticket",
    });
  });

  it("does not let a retry replace an existing owner", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    expect(
      await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-b", kind: "ticket" }),
    ).toBe(false);
    expect((await registry.get(subjectKey))?.ownerToken).toBe("owner-a");
  });

  it("only lets the reservation owner bind a candidate workflow run", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });

    expect(await registry.bindRun(subjectKey, "owner-b", "run-loser")).toBe(false);
    expect(await registry.bindRun(subjectKey, "owner-a", "run-winner")).toBe(true);
    expect(await registry.bindRun(subjectKey, "owner-a", "run-retry")).toBe(false);
    expect(await registry.get(subjectKey)).toMatchObject({ state: "bound", runId: "run-winner" });
  });

  it("does not bind a reservation after its capacity grace expires", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await db
      .update(activeRuns)
      .set({ updatedAt: new Date(Date.now() - RESERVATION_BIND_GRACE_MS - 1_000) })
      .where(eq(activeRuns.subjectKey, subjectKey));

    expect(await registry.bindRun(subjectKey, "owner-a", "run-too-late")).toBe(false);
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-a",
      state: "reserved",
      runId: null,
    });
  });

  it("releases only reservations whose database bind grace has expired", async () => {
    const staleSubject = "ticket:jira:PROJ-STALE-RELEASE";
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-fresh",
      kind: "ticket",
    });
    await registry.reserve({
      subjectKey: staleSubject,
      ticketKey: "PROJ-STALE-RELEASE",
      ownerToken: "owner-stale",
      kind: "ticket",
    });
    await db
      .update(activeRuns)
      .set({ updatedAt: new Date(Date.now() - RESERVATION_BIND_GRACE_MS - 1_000) })
      .where(eq(activeRuns.subjectKey, staleSubject));

    await expect(
      registry.releaseExpiredReservation(subjectKey, "owner-fresh"),
    ).resolves.toBe(false);
    await expect(
      registry.releaseExpiredReservation(staleSubject, "owner-stale"),
    ).resolves.toBe(true);
    await expect(registry.get(subjectKey)).resolves.not.toBeNull();
    await expect(registry.get(staleSubject)).resolves.toBeNull();
  });

  it("excludes reservations from capacity when the database bind grace has expired", async () => {
    const staleSubject = "ticket:jira:PROJ-STALE";
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-fresh",
      kind: "ticket",
    });
    await registry.reserve({
      subjectKey: staleSubject,
      ticketKey: "PROJ-STALE",
      ownerToken: "owner-stale",
      kind: "ticket",
    });
    await db
      .update(activeRuns)
      .set({ updatedAt: new Date(Date.now() - RESERVATION_BIND_GRACE_MS - 1_000) })
      .where(eq(activeRuns.subjectKey, staleSubject));

    expect(
      (await registry.listCapacityConsumers()).map((entry) => entry.subjectKey),
    ).toEqual([subjectKey]);
  });

  it("returns whether owner-matching terminal release actually deleted", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");

    expect(await registry.release(subjectKey, "owner-b", "run-winner")).toBe(false);
    expect(await registry.release(subjectKey, "owner-a", "run-other")).toBe(false);
    expect(await registry.release(subjectKey, "owner-a", "run-winner")).toBe(true);
    expect(await registry.release(subjectKey, "owner-a", "run-winner")).toBe(false);
  });

  it("terminal-releases an exact parked owner after its checkpoint stops protecting it", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");
    await registry.beginParking(subjectKey, "owner-a", "run-winner");
    await registry.finishParking(subjectKey, "owner-a", "run-winner");

    expect(await registry.release(subjectKey, "owner-a", "run-winner")).toBe(true);
    expect(await registry.get(subjectKey)).toBeNull();
  });

  it("closes an exact owner before cancellation cleanup and releases only that closed claim", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");

    expect(
      await registry.beginCancellation(subjectKey, "owner-a", "run-other"),
    ).toBe(false);
    expect(
      await registry.beginCancellation(subjectKey, "owner-a", "run-winner"),
    ).toBe(true);
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-a",
      runId: "run-winner",
      state: "cancelling",
    });
    expect(
      (await db.select().from(activeRuns))[0]?.ticketCancellationReconciledVersion,
    ).toBe(-1);
    expect(
      await registry.releaseCancellation(subjectKey, "owner-a", "run-other"),
    ).toBe(false);
    expect(
      await registry.releaseCancellation(subjectKey, "owner-a", "run-winner"),
    ).toBe(false);
    expect(
      await registry.releaseCancellation(subjectKey, "owner-a", "run-winner", {
        latestFenceId: null,
        mutationVersion: 0,
      }),
    ).toBe(true);
    expect(await registry.get(subjectKey)).toBeNull();
  });

  it("does not let a cancelled owner create a failed-ticket marker", async () => {
    const meta = {
      runId: "run-winner",
      error: "failed to move ticket to backlog",
      failedAt: "2026-07-19T12:00:00.000Z",
    };
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");
    await registry.beginCancellation(subjectKey, "owner-a", "run-winner");

    await registry.markFailed("PROJ-1", meta, {
      subjectKey,
      ownerToken: "owner-a",
      runId: "run-winner",
    });

    expect(await registry.listAllFailed()).toEqual([]);
  });

  it("clears the exact owner's failed-ticket marker when cancellation wins second", async () => {
    const meta = {
      runId: "run-winner",
      error: "failed to move ticket to backlog",
      failedAt: "2026-07-19T12:00:00.000Z",
    };
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");
    await registry.markFailed("PROJ-1", meta, {
      subjectKey,
      ownerToken: "owner-a",
      runId: "run-winner",
    });
    expect(await registry.listAllFailed()).toEqual([{ ticketKey: "PROJ-1", meta }]);

    await registry.beginCancellation(subjectKey, "owner-a", "run-winner");

    expect(await registry.listAllFailed()).toEqual([]);
  });

  it("rejects failed-ticket markers from the wrong exact owner", async () => {
    const meta = {
      runId: "run-winner",
      error: "failed to move ticket to backlog",
      failedAt: "2026-07-19T12:00:00.000Z",
    };
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");

    await registry.markFailed("PROJ-1", meta, {
      subjectKey,
      ownerToken: "owner-b",
      runId: "run-winner",
    });

    expect(await registry.listAllFailed()).toEqual([]);
  });

  it("rejects a marker whose metadata run differs from the exact owner run", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");

    await registry.markFailed("PROJ-1", {
      runId: "run-stale",
      error: "failed to move ticket to backlog",
      failedAt: "2026-07-19T12:00:00.000Z",
    }, {
      subjectKey,
      ownerToken: "owner-a",
      runId: "run-winner",
    });

    expect(await registry.listAllFailed()).toEqual([]);
  });

  it.each([
    ["subject", { subjectKey: "ticket:jira:PROJ-OTHER", ownerToken: "owner-a", runId: "run-winner" }, "PROJ-1"],
    ["ticket", { subjectKey, ownerToken: "owner-a", runId: "run-winner" }, "PROJ-OTHER"],
  ] as const)("rejects a marker with the wrong exact-owner %s", async (_field, owner, ticketKey) => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");

    await registry.markFailed(ticketKey, {
      runId: "run-winner",
      error: "failed to move ticket to backlog",
      failedAt: "2026-07-19T12:00:00.000Z",
    }, owner);

    expect(await registry.listAllFailed()).toEqual([]);
  });

  it("preserves a different-run marker for the same ticket through cancellation", async () => {
    const oldMeta = {
      runId: "run-old",
      error: "old run failed",
      failedAt: "2026-07-19T12:00:00.000Z",
    };
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-old",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-old", "run-old");
    await registry.markFailed("PROJ-1", oldMeta, {
      subjectKey,
      ownerToken: "owner-old",
      runId: "run-old",
    });
    expect(await registry.release(subjectKey, "owner-old", "run-old")).toBe(true);
    expect(await registry.listAllFailed()).toEqual([{ ticketKey: "PROJ-1", meta: oldMeta }]);

    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-new",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-new", "run-new");
    await registry.beginCancellation(subjectKey, "owner-new", "run-new");

    expect(await registry.listAllFailed()).toEqual([{ ticketKey: "PROJ-1", meta: oldMeta }]);
  });

  it("orders cancellation after a locked marker write and clears that exact marker", async () => {
    const meta = {
      runId: "run-winner",
      error: "failed to move ticket to backlog",
      failedAt: "2026-07-19T12:00:00.000Z",
    };
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");
    const markerWritten = deferred();
    const releaseMarker = deferred();
    const markerTransaction = db.transaction(async (tx) => {
      const txRegistry = new PostgresRunRegistry(tx as unknown as Db);
      await txRegistry.markFailed("PROJ-1", meta, {
        subjectKey,
        ownerToken: "owner-a",
        runId: "run-winner",
      });
      markerWritten.resolve();
      await releaseMarker.promise;
    });
    await markerWritten.promise;

    let cancellationSettled = false;
    const cancellation = registry
      .beginCancellation(subjectKey, "owner-a", "run-winner")
      .then((result) => {
        cancellationSettled = true;
        return result;
      });
    await nextTurn();
    expect(cancellationSettled).toBe(false);

    releaseMarker.resolve();
    await markerTransaction;
    expect(await cancellation).toBe(true);
    expect(await registry.listAllFailed()).toEqual([]);
  });

  it("orders a marker write after locked cancellation and suppresses the stale insert", async () => {
    const meta = {
      runId: "run-winner",
      error: "failed to move ticket to backlog",
      failedAt: "2026-07-19T12:00:00.000Z",
    };
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");
    const cancellationStarted = deferred();
    const releaseCancellation = deferred();
    const cancellationTransaction = db.transaction(async (tx) => {
      const txRegistry = new PostgresRunRegistry(tx as unknown as Db);
      expect(
        await txRegistry.beginCancellation(subjectKey, "owner-a", "run-winner"),
      ).toBe(true);
      cancellationStarted.resolve();
      await releaseCancellation.promise;
    });
    await cancellationStarted.promise;

    let markerSettled = false;
    const marker = registry
      .markFailed("PROJ-1", meta, {
        subjectKey,
        ownerToken: "owner-a",
        runId: "run-winner",
      })
      .then(() => {
        markerSettled = true;
      });
    await nextTurn();
    expect(markerSettled).toBe(false);

    releaseCancellation.resolve();
    await cancellationTransaction;
    await marker;
    expect(await registry.listAllFailed()).toEqual([]);
  });

  it("preserves failed-ticket markers owned by an unrelated active run", async () => {
    const otherSubject = "ticket:jira:PROJ-2";
    const otherMeta = {
      runId: "run-other",
      error: "failed to move other ticket",
      failedAt: "2026-07-19T12:00:00.000Z",
    };
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");
    await registry.reserve({
      subjectKey: otherSubject,
      ticketKey: "PROJ-2",
      ownerToken: "owner-b",
      kind: "ticket",
    });
    await registry.bindRun(otherSubject, "owner-b", "run-other");
    await registry.markFailed("PROJ-1", { ...otherMeta, runId: "run-winner" }, {
      subjectKey,
      ownerToken: "owner-a",
      runId: "run-winner",
    });
    await registry.markFailed("PROJ-2", otherMeta, {
      subjectKey: otherSubject,
      ownerToken: "owner-b",
      runId: "run-other",
    });

    await registry.beginCancellation(subjectKey, "owner-a", "run-winner");

    expect(await registry.listAllFailed()).toEqual([
      { ticketKey: "PROJ-2", meta: otherMeta },
    ]);
  });

  it("closes and releases an unbound reservation without allowing it to bind", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });

    expect(await registry.beginCancellation(subjectKey, "owner-a", null)).toBe(true);
    expect(await registry.bindRun(subjectKey, "owner-a", "run-too-late")).toBe(false);
    expect(await registry.get(subjectKey)).toMatchObject({
      runId: null,
      state: "cancelling",
    });
    expect(await registry.releaseCancellation(subjectKey, "owner-a", null)).toBe(false);
    expect(
      await registry.releaseCancellation(subjectKey, "owner-a", null, {
        latestFenceId: null,
        mutationVersion: 0,
      }),
    ).toBe(true);
  });

  it("releases only the exact ticket mutation version and newest human fence it reconciled", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");
    await registry.beginCancellation(subjectKey, "owner-a", "run-winner");
    const [first] = await db
      .insert(ticketCancellationFences)
      .values({
        ticketKey: "PROJ-1",
        subjectKey,
        ownerToken: "owner-a",
        runId: "run-winner",
        targetStatusName: "Backlog",
        webhookIdentifier: "human-fence-a",
        occurredAt: new Date("2026-07-18T12:00:00Z"),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: ticketCancellationFences.id });
    const [second] = await db
      .insert(ticketCancellationFences)
      .values({
        ticketKey: "PROJ-1",
        subjectKey,
        ownerToken: "owner-a",
        runId: "run-winner",
        targetStatusName: "Blocked",
        webhookIdentifier: "human-fence-b",
        occurredAt: new Date("2026-07-18T12:00:01Z"),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: ticketCancellationFences.id });
    await db
      .update(activeRuns)
      .set({ ticketMutationVersion: 2 })
      .where(eq(activeRuns.subjectKey, subjectKey));

    await expect(
      registry.releaseCancellation(subjectKey, "owner-a", "run-winner", {
        latestFenceId: first!.id,
        mutationVersion: 2,
      }),
    ).resolves.toBe(false);
    await expect(
      registry.releaseCancellation(subjectKey, "owner-a", "run-winner", {
        latestFenceId: second!.id,
        mutationVersion: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      registry.releaseCancellation(subjectKey, "owner-a", "run-winner", {
        latestFenceId: second!.id,
        mutationVersion: 2,
      }),
    ).resolves.toBe(true);
  });

  it("retains a cancelling ticket owner while an exact provider call is unresolved", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");
    await registry.beginCancellation(subjectKey, "owner-a", "run-winner");
    const [intent] = await db
      .insert(ticketTransitionIntents)
      .values({
        ticketKey: "PROJ-1",
        subjectKey,
        ownerToken: "owner-a",
        runId: "run-winner",
        actorAccountId: "jira-bot",
        targetStatusName: "Backlog",
        providerStartedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: ticketTransitionIntents.id });
    await db
      .update(activeRuns)
      .set({ ticketMutationVersion: 1 })
      .where(eq(activeRuns.subjectKey, subjectKey));

    await expect(
      registry.releaseCancellation(subjectKey, "owner-a", "run-winner", {
        latestFenceId: null,
        mutationVersion: 1,
      }),
    ).resolves.toBe(false);
    await db
      .update(ticketTransitionIntents)
      .set({ providerFinishedAt: new Date() })
      .where(eq(ticketTransitionIntents.id, intent!.id));
    await expect(
      registry.releaseCancellation(subjectKey, "owner-a", "run-winner", {
        latestFenceId: null,
        mutationVersion: 1,
      }),
    ).resolves.toBe(true);
  });

  it("retains a cancelling ticket owner while an exact label call is unresolved", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");
    await registry.beginCancellation(subjectKey, "owner-a", "run-winner");
    const [intent] = await db
      .insert(ticketLabelMutationIntents)
      .values({
        ticketKey: "PROJ-1",
        subjectKey,
        ownerToken: "owner-a",
        runId: "run-winner",
        removeLabels: ["needs-clarification"],
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: ticketLabelMutationIntents.id });

    await expect(
      registry.releaseCancellation(subjectKey, "owner-a", "run-winner", {
        latestFenceId: null,
        mutationVersion: 1,
      }),
    ).resolves.toBe(false);
    await db
      .update(ticketLabelMutationIntents)
      .set({ providerFinishedAt: new Date() })
      .where(eq(ticketLabelMutationIntents.id, intent!.id));
    await expect(
      registry.releaseCancellation(subjectKey, "owner-a", "run-winner", {
        latestFenceId: null,
        mutationVersion: 1,
      }),
    ).resolves.toBe(true);
  });

  it.each(["parking", "parked"] as const)(
    "lets cancellation close an exact %s clarification predecessor",
    async (state) => {
      await registry.reserve({
        subjectKey,
        ticketKey: "PROJ-1",
        ownerToken: "owner-a",
        kind: "ticket",
      });
      await registry.bindRun(subjectKey, "owner-a", "run-a");
      await registry.beginParking(subjectKey, "owner-a", "run-a");
      if (state === "parked") {
        await registry.finishParking(subjectKey, "owner-a", "run-a");
      }

      expect(await registry.beginCancellation(subjectKey, "owner-a", "run-a")).toBe(true);
      expect(await registry.get(subjectKey)).toMatchObject({ state: "cancelling" });
    },
  );

  it("cannot terminal-release an unbound reservation and cannot reservation-release a bound run", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    expect(await registry.release(subjectKey, "owner-a", "run-a")).toBe(false);
    expect(await registry.bindRun(subjectKey, "owner-a", "run-a")).toBe(true);
    expect(await registry.releaseReservation(subjectKey, "owner-a")).toBe(false);
    expect((await registry.get(subjectKey))?.runId).toBe("run-a");
  });

  it("lets only the owner discard an unbound reservation", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    expect(await registry.releaseReservation(subjectKey, "owner-b")).toBe(false);
    expect(await registry.releaseReservation(subjectKey, "owner-a")).toBe(true);
    expect(await registry.get(subjectKey)).toBeNull();
  });

  it("keeps an approval's reserved owner until its ambiguous Jira transition settles", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "approval-owner",
      kind: "ticket",
    });
    const [intent] = await db
      .insert(ticketTransitionIntents)
      .values({
        ticketKey: "PROJ-1",
        subjectKey,
        ownerToken: "approval-owner",
        runId: null,
        actorAccountId: "jira-bot",
        targetStatusName: "AI",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: ticketTransitionIntents.id });

    await expect(
      registry.bindRun(subjectKey, "approval-owner", "run-too-early"),
    ).resolves.toBe(false);
    await expect(
      registry.handoff(subjectKey, "approval-owner", "replacement-owner"),
    ).resolves.toBe(false);
    await expect(
      registry.releaseReservation(subjectKey, "approval-owner"),
    ).resolves.toBe(false);

    await db
      .update(ticketTransitionIntents)
      .set({ providerFinishedAt: new Date() })
      .where(eq(ticketTransitionIntents.id, intent!.id));
    await expect(
      registry.releaseReservation(subjectKey, "approval-owner"),
    ).resolves.toBe(true);
  });

  it("owner-only reservation handoff never overwrites a bound run", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    expect(await registry.handoff(subjectKey, "owner-a", "owner-b")).toBe(true);
    expect((await registry.get(subjectKey))?.ownerToken).toBe("owner-b");
    await registry.bindRun(subjectKey, "owner-b", "run-b");
    expect(await registry.handoff(subjectKey, "owner-b", "owner-c")).toBe(false);
    expect((await registry.get(subjectKey))?.runId).toBe("run-b");
  });

  it("CAS-hands an exact parked run to one unbound successor reservation", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-parked", kind: "ticket" });
    await registry.bindRun(subjectKey, "owner-parked", "run-parked");
    await registry.beginParking(subjectKey, "owner-parked", "run-parked");
    await registry.finishParking(subjectKey, "owner-parked", "run-parked");

    expect(
      await registry.handoffBoundRun(subjectKey, "owner-parked", "run-other", "owner-loser"),
    ).toBe(false);
    expect(
      await registry.handoffBoundRun(subjectKey, "owner-parked", "run-parked", "owner-successor"),
    ).toBe(true);
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-successor",
      runId: null,
      state: "reserved",
    });
    expect(
      await registry.handoffBoundRun(subjectKey, "owner-parked", "run-parked", "owner-second"),
    ).toBe(false);
    expect(await registry.bindRun(subjectKey, "owner-successor", "run-winner")).toBe(true);
    expect(await registry.bindRun(subjectKey, "owner-successor", "run-retry-loser")).toBe(false);
  });

  it("makes the exact registration barrier retry-safe while parking", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-parked",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-parked", "run-parked");

    expect(await registry.beginParking(subjectKey, "owner-parked", "run-parked")).toBe(true);
    expect(await registry.beginParking(subjectKey, "owner-parked", "run-parked")).toBe(true);
    expect(await registry.beginParking(subjectKey, "owner-other", "run-parked")).toBe(false);
  });

  it("gates handoff on the exact durable parking drain, independently of telemetry", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-parked",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-parked", "run-parked");
    await registry.registerSandbox(subjectKey, "owner-parked", "sandbox-still-active");

    expect(
      await registry.handoffBoundRun(
        subjectKey,
        "owner-parked",
        "run-parked",
        "owner-too-early",
      ),
    ).toBe(false);
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-parked",
      runId: "run-parked",
      state: "bound",
    });
    expect(await registry.listSandboxes(subjectKey, "owner-parked")).toEqual([
      "sandbox-still-active",
    ]);

    expect(
      await registry.beginParking(subjectKey, "owner-parked", "run-other"),
    ).toBe(false);
    expect(
      await registry.beginParking(subjectKey, "owner-parked", "run-parked"),
    ).toBe(true);
    expect(await registry.get(subjectKey)).toMatchObject({ state: "parking" });
    await expect(
      registry.registerSandbox(
        subjectKey,
        "owner-parked",
        "sandbox-after-barrier",
        "run-parked",
      ),
    ).rejects.toThrow("owner does not hold active run");
    expect(
      await registry.handoffBoundRun(
        subjectKey,
        "owner-parked",
        "run-parked",
        "owner-still-too-early",
      ),
    ).toBe(false);
    expect(await registry.listSandboxes(subjectKey, "owner-parked")).toEqual([
      "sandbox-still-active",
    ]);

    expect(
      await registry.finishParking(subjectKey, "owner-parked", "run-parked"),
    ).toBe(true);
    expect(await registry.get(subjectKey)).toMatchObject({ state: "parked" });
    expect(await registry.listSandboxes(subjectKey, "owner-parked")).toEqual([]);

    expect(
      await registry.handoffBoundRun(
        subjectKey,
        "owner-parked",
        "run-parked",
        "owner-successor",
      ),
    ).toBe(true);
    expect(await registry.listSandboxes(subjectKey, "owner-parked")).toEqual([]);
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-successor",
      runId: null,
      state: "reserved",
    });
  });

  it("CAS-restores a capacity-losing successor without dropping the parked subject", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-parked",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-parked", "run-parked");
    await registry.beginParking(subjectKey, "owner-parked", "run-parked");
    await registry.finishParking(subjectKey, "owner-parked", "run-parked");
    await registry.handoffBoundRun(
      subjectKey,
      "owner-parked",
      "run-parked",
      "owner-successor",
    );

    expect(
      await registry.restoreParkedRun(
        subjectKey,
        "owner-other",
        "owner-parked",
        "run-parked",
      ),
    ).toBe(false);
    expect(
      await registry.restoreParkedRun(
        subjectKey,
        "owner-successor",
        "owner-parked",
        "run-parked",
      ),
    ).toBe(true);
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-parked",
      runId: "run-parked",
      state: "parked",
    });
  });

  it("refreshes reservation freshness when a parked run hands off", async () => {
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-parked",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-parked", "run-parked");
    await registry.beginParking(subjectKey, "owner-parked", "run-parked");
    await registry.finishParking(subjectKey, "owner-parked", "run-parked");
    await db
      .update(activeRuns)
      .set({ updatedAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(activeRuns.subjectKey, subjectKey));
    const before = Date.now();

    expect(
      await registry.handoffBoundRun(
        subjectKey,
        "owner-parked",
        "run-parked",
        "owner-successor",
      ),
    ).toBe(true);
    expect((await registry.get(subjectKey))?.updatedAt).toBeGreaterThanOrEqual(
      before - 1_000,
    );
  });
});

describe("subject metadata and capacity listing", () => {
  it("keeps synthetic PR subjects ticket-free", async () => {
    await registry.reserve({
      subjectKey: "pr:github:acme/api#42",
      ticketKey: null,
      ownerToken: "owner-pr",
      kind: "pr_trigger",
    });
    expect(await registry.listAll()).toEqual([
      expect.objectContaining({
        subjectKey: "pr:github:acme/api#42",
        ticketKey: null,
        ownerToken: "owner-pr",
        runId: null,
        state: "reserved",
        kind: "pr_trigger",
      }),
    ]);
  });

  it("records reservation and update timestamps", async () => {
    const before = Date.now();
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    const entry = await registry.get(subjectKey);
    expect(entry?.createdAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(entry?.updatedAt).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("counts every live run while same-run clarifications are suspended", async () => {
    const parkedSubject = "ticket:jira:PROJ-PARKED";
    const answeredSubject = "ticket:jira:PROJ-ANSWERED";
    const activeSubject = "ticket:jira:PROJ-ACTIVE";
    const cancellingSubject = "ticket:jira:PROJ-CANCELLING";
    const expiredSubject = "ticket:jira:PROJ-EXPIRED";
    const parkingSubject = "ticket:jira:PROJ-PARKING";
    await db.insert(activeRuns).values([
      {
        subjectKey: parkedSubject,
        ticketKey: "PROJ-PARKED",
        ownerToken: "owner-parked",
        runId: "run-parked",
        state: "parked",
      },
      {
        subjectKey: answeredSubject,
        ticketKey: "PROJ-ANSWERED",
        ownerToken: "owner-answered",
        runId: "run-answered",
        state: "parked",
      },
      {
        subjectKey: activeSubject,
        ticketKey: "PROJ-ACTIVE",
        ownerToken: "owner-active",
        runId: "run-active",
        state: "bound",
      },
      {
        subjectKey: cancellingSubject,
        ticketKey: "PROJ-CANCELLING",
        ownerToken: "owner-cancelling",
        runId: "run-cancelling",
        state: "cancelling",
        ticketCancellationReconciledVersion: -1,
      },
      {
        subjectKey: expiredSubject,
        ticketKey: "PROJ-EXPIRED",
        ownerToken: "owner-expired",
        runId: "run-expired",
        state: "parked",
      },
      {
        subjectKey: parkingSubject,
        ticketKey: "PROJ-PARKING",
        ownerToken: "owner-parking",
        runId: "run-parking",
        state: "parking",
      },
    ]);
    await db.insert(clarificationRequests).values([
      {
        id: "clarification-parked",
        ticketKey: "PROJ-PARKED",
        subjectKey: parkedSubject,
        ownerToken: "owner-parked",
        runId: "run-parked",
        questions: ["Which implementation?"],
        status: "pending",
        checkpointState: "ready",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "clarification-answered",
        ticketKey: "PROJ-ANSWERED",
        subjectKey: answeredSubject,
        ownerToken: "owner-answered",
        runId: "run-answered",
        questions: ["Which implementation?"],
        status: "answered",
        answer: "Use the existing pattern",
        successorOwnerToken: "owner-successor",
        checkpointState: "ready",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "clarification-active-mismatch",
        ticketKey: "PROJ-ACTIVE",
        subjectKey: activeSubject,
        ownerToken: "a-different-owner",
        runId: "run-active",
        questions: ["This must not park the active owner"],
        status: "pending",
        checkpointState: "ready",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "clarification-cancelling",
        ticketKey: "PROJ-CANCELLING",
        subjectKey: cancellingSubject,
        ownerToken: "owner-cancelling",
        runId: "run-cancelling",
        questions: ["Cancellation must still occupy capacity"],
        status: "pending",
        checkpointState: "ready",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "clarification-expired",
        ticketKey: "PROJ-EXPIRED",
        subjectKey: expiredSubject,
        ownerToken: "owner-expired",
        runId: "run-expired",
        questions: ["Expired checkpoints are not safely parked"],
        status: "pending",
        checkpointState: "ready",
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        publishedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        id: "clarification-parking",
        ticketKey: "PROJ-PARKING",
        subjectKey: parkingSubject,
        ownerToken: "owner-parking",
        runId: "run-parking",
        questions: ["Parking must still occupy capacity"],
        status: "pending",
        checkpointState: "ready",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    expect(
      (await registry.listCapacityConsumers()).map((entry) => entry.subjectKey).sort(),
    ).toEqual([
      parkedSubject,
      answeredSubject,
      activeSubject,
      cancellingSubject,
      expiredSubject,
      parkingSubject,
    ].sort());
    expect((await registry.listAll()).map((entry) => entry.subjectKey).sort()).toEqual(
      [
        parkedSubject,
        answeredSubject,
        activeSubject,
        cancellingSubject,
        expiredSubject,
        parkingSubject,
      ].sort(),
    );
  });

  it("does not exempt legacy parked clarification rows from capacity", async () => {
    const boundSubject = "ticket:jira:PROJ-BOUND";
    const parkingSubject = "ticket:jira:PROJ-PARKING";
    const wrongOwnerSubject = "ticket:jira:PROJ-WRONG-OWNER";
    const parkedSubject = "ticket:jira:PROJ-PARKED";
    const subjects = [
      [boundSubject, "owner-bound", "run-bound", "bound"],
      [parkingSubject, "owner-parking", "run-parking", "parking"],
      [wrongOwnerSubject, "owner-current", "run-wrong-owner", "parked"],
      [parkedSubject, "owner-parked", "run-parked", "parked"],
    ] as const;
    await db.insert(activeRuns).values(
      subjects.map(([subject, ownerToken, runId, state]) => ({
        subjectKey: subject,
        ticketKey: subject.slice("ticket:jira:".length),
        ownerToken,
        runId,
        state,
      })),
    );
    await db.insert(clarificationRequests).values(
      subjects.map(([subject, ownerToken, runId]) => ({
        id: `clarification-${runId}`,
        ticketKey: subject.slice("ticket:jira:".length),
        subjectKey: subject,
        ownerToken: subject === wrongOwnerSubject ? "owner-predecessor" : ownerToken,
        runId,
        questions: ["Which implementation?"],
        status: "pending",
        checkpointState: "ready",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      })),
    );

    expect(
      (await registry.listCapacityConsumers()).map((entry) => entry.subjectKey).sort(),
    ).toEqual(
      [boundSubject, parkingSubject, wrongOwnerSubject, parkedSubject].sort(),
    );
  });

  it("rejects raw rows whose state and run id disagree", async () => {
    await expect(
      db.insert(activeRuns).values({
        subjectKey: "ticket:jira:PROJ-2",
        ticketKey: "PROJ-2",
        ownerToken: "owner-b",
        state: "reserved",
        runId: "run-should-be-null",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(activeRuns).values({
        subjectKey: "ticket:jira:PROJ-3",
        ticketKey: "PROJ-3",
        ownerToken: "owner-c",
        state: "bound",
        runId: null,
      }),
    ).rejects.toThrow();
  });
});

describe("owner-isolated child sandboxes", () => {
  beforeEach(async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    await registry.bindRun(subjectKey, "owner-a", "run-a");
  });

  it("registers and lists every scratch/code sandbox for the owner", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-code");
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-scratch");
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([
      "sandbox-code",
      "sandbox-scratch",
    ]);
  });

  it("rejects sandbox registration by a stale owner", async () => {
    await expect(
      registry.registerSandbox(subjectKey, "owner-b", "sandbox-orphan"),
    ).rejects.toBeInstanceOf(ActiveRunOwnerError);
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([]);
  });

  it("rejects a sandbox registration for the right owner but wrong run", async () => {
    await expect(
      registry.registerSandbox(subjectKey, "owner-a", "sandbox-orphan", "run-other"),
    ).rejects.toThrow("owner does not hold active run");
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([]);
  });

  it("prevents every new sandbox registration once cancellation closes the owner", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-before-close");
    expect(await registry.beginCancellation(subjectKey, "owner-a", "run-a")).toBe(true);

    await expect(
      registry.registerSandbox(subjectKey, "owner-a", "sandbox-after-close"),
    ).rejects.toThrow("owner does not hold active run");
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([
      "sandbox-before-close",
    ]);
  });

  it("does not expose one owner's sandboxes through another owner", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-a");
    expect(await registry.listSandboxes(subjectKey, "owner-b")).toEqual([]);
  });

  it("unregisters one stopped sandbox without releasing the parked owner", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-code");
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-scratch");
    expect(await registry.unregisterSandbox(subjectKey, "owner-a", "sandbox-code")).toBe(true);
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual(["sandbox-scratch"]);
    expect(await registry.get(subjectKey)).toMatchObject({ ownerToken: "owner-a", runId: "run-a" });
  });

  it("clears predecessor sandbox registrations at the durable parked boundary", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-a");
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-b");
    expect(await registry.beginParking(subjectKey, "owner-a", "run-a")).toBe(true);
    expect(await registry.finishParking(subjectKey, "owner-a", "run-a")).toBe(true);
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([]);
    expect(await registry.handoffBoundRun(subjectKey, "owner-a", "run-a", "owner-next")).toBe(true);
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([]);
    expect(await registry.listSandboxes(subjectKey, "owner-next")).toEqual([]);
  });

  it("enforces subject plus owner isolation at the database boundary", async () => {
    await expect(
      db.insert(activeRunSandboxes).values({
        subjectKey,
        ownerToken: "owner-b",
        sandboxId: "sandbox-b",
      }),
    ).rejects.toThrow();
  });

  it("terminal owner release removes all child sandbox registrations", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-a");
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-b");
    expect(await registry.release(subjectKey, "owner-a", "run-a")).toBe(true);
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([]);
  });
});

describe("ticket-only stores", () => {
  it("round-trips failed ticket and thread metadata independently of subject claims", async () => {
    const meta = {
      runId: "run-a",
      error: "failed",
      failedAt: "2026-07-17T12:00:00.000Z",
    };
    await registry.reserve({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    await registry.bindRun(subjectKey, "owner-a", "run-a");
    await registry.markFailed("PROJ-1", meta, {
      subjectKey,
      ownerToken: "owner-a",
      runId: "run-a",
    });
    await registry.setParent("PROJ-1", "1777542341.966359");
    expect(await registry.listAllFailed()).toEqual([{ ticketKey: "PROJ-1", meta }]);
    expect(await registry.getParent("PROJ-1")).toBe("1777542341.966359");
    await registry.clearFailedMark("PROJ-1");
    await registry.clearParent("PROJ-1");
    expect(await registry.isTicketFailed("PROJ-1")).toBe(false);
    expect(await registry.getParent("PROJ-1")).toBeNull();
  });
});
