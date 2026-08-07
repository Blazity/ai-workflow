import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  activeRuns,
  scheduleOccurrences,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowSchedules,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  acceptOccurrence,
  expirePendingOccurrences,
  getOccurrence,
  isUniqueViolation,
  listOccurrencesForSchedule,
  listPendingOccurrences,
  recordOccurrenceAtCapacity,
  recordOccurrenceError,
  recordOccurrenceSkipped,
  recordOccurrenceStarted,
  supersedePendingThenAccept,
  sweepSettledOccurrences,
  type AdmittedOccurrence,
  type ScheduleOccurrenceOutcome,
} from "./occurrence-store.js";

let db: Db;

const SCHEDULE_ID = "sch_test";
const OTHER_SCHEDULE_ID = "sch_other";
const AT_09 = new Date("2026-08-01T09:00:00.000Z");
const AT_10 = new Date("2026-08-01T10:00:00.000Z");
const AT_11 = new Date("2026-08-01T11:00:00.000Z");
const AT_12 = new Date("2026-08-01T12:00:00.000Z");

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(workflowDefinitions).values({
    id: 9,
    name: "Nightly sweep",
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowDefinitionVersions).values(
    [3, 4].map((version) => ({
      definitionId: 9,
      version,
      definition: {},
      createdById: "test",
      createdByLabel: "Test",
    })),
  );
  await db.insert(workflowSchedules).values([
    { id: SCHEDULE_ID, definitionId: 9, nodeId: "entry", cron: "0 * * * *" },
    { id: OTHER_SCHEDULE_ID, definitionId: 9, nodeId: "second", cron: "0 3 * * *" },
  ]);
});

function admitted(
  occurrenceAt = AT_10,
  overrides: Partial<AdmittedOccurrence> = {},
): AdmittedOccurrence {
  return {
    scheduleId: SCHEDULE_ID,
    occurrenceAt,
    definitionId: 9,
    definitionVersion: 3,
    droppedOlder: 0,
    droppedOlderAtLeast: false,
    ...overrides,
  };
}

async function backdate(occurrenceAt: Date, createdAt: Date): Promise<void> {
  await db
    .update(scheduleOccurrences)
    .set({ createdAt })
    .where(eq(scheduleOccurrences.occurrenceAt, occurrenceAt));
}

async function pinDispatchedAt(occurrenceAt: Date, dispatchedAt: Date): Promise<void> {
  await db
    .update(scheduleOccurrences)
    .set({ dispatchedAt })
    .where(eq(scheduleOccurrences.occurrenceAt, occurrenceAt));
}

/** Force a terminal outcome directly, to test that settled is really terminal. */
async function settle(
  occurrenceAt: Date,
  outcome: ScheduleOccurrenceOutcome,
): Promise<void> {
  await db
    .update(scheduleOccurrences)
    .set({ outcome, pending: false })
    .where(eq(scheduleOccurrences.occurrenceAt, occurrenceAt));
}

async function reserve(
  ownerToken: string,
  subjectKey = "schedule:sch_test",
): Promise<void> {
  await db.insert(activeRuns).values({ subjectKey, ownerToken });
}

function causeMessage(error: unknown): string {
  return String((error as { cause?: { message?: string } })?.cause?.message ?? error);
}

describe("acceptOccurrence", () => {
  it("admits an occurrence pending, pinned to the version it was admitted under", async () => {
    const result = await acceptOccurrence(db, admitted());
    expect(result.admitted).toBe(true);
    expect({
      scheduleId: result.stored.scheduleId,
      occurrenceAt: result.stored.occurrenceAt,
      definitionId: result.stored.definitionId,
      definitionVersion: result.stored.definitionVersion,
      pending: result.stored.pending,
      outcome: result.stored.outcome,
      droppedCount: result.stored.droppedCount,
      droppedCountCapped: result.stored.droppedCountCapped,
      attemptCount: result.stored.attemptCount,
      runId: result.stored.runId,
      dispatchedAt: result.stored.dispatchedAt,
    }).toEqual({
      scheduleId: SCHEDULE_ID,
      occurrenceAt: AT_10,
      definitionId: 9,
      definitionVersion: 3,
      pending: true,
      outcome: null,
      droppedCount: 0,
      droppedCountCapped: false,
      attemptCount: 0,
      runId: null,
      dispatchedAt: null,
    });
  });

  it("stores the backlog the evaluator passed over, and whether it is a floor", async () => {
    // Without these the occurrence that DOES run records a dropped count of zero,
    // so a schedule that was down for four days reads as perfectly healthy.
    const result = await acceptOccurrence(
      db,
      admitted(AT_10, { droppedOlder: 50, droppedOlderAtLeast: true }),
    );
    expect({
      droppedCount: result.stored.droppedCount,
      droppedCountCapped: result.stored.droppedCountCapped,
    }).toEqual({ droppedCount: 50, droppedCountCapped: true });
  });

  it("replays the first decision when the same occurrence is re-evaluated", async () => {
    const first = await acceptOccurrence(db, admitted());
    await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_overlap", {
      blockingRunId: "run-1",
    });
    const second = await acceptOccurrence(db, admitted(AT_10, { definitionVersion: 4 }));
    expect(second.admitted).toBe(false);
    expect(second.stored.outcome).toBe("skipped_overlap");
    expect(second.stored.blockingRunId).toBe("run-1");
    expect(second.stored.definitionVersion).toBe(3);
    expect(second.stored.createdAt).toEqual(first.stored.createdAt);
  });

  it("records a settled row for an occurrence that could not take the pending slot", async () => {
    // The one-pending index is partial on pending = true, so a row inserted
    // already settled cannot violate it. That turns what used to be a raised
    // 23505 and a silent hole in the ledger into a readable skipped_overlap row.
    await acceptOccurrence(db, admitted(AT_10));
    const blocked = await acceptOccurrence(db, admitted(AT_11));

    expect(blocked.admitted).toBe(false);
    expect({
      pending: blocked.stored.pending,
      outcome: blocked.stored.outcome,
    }).toEqual({ pending: false, outcome: "skipped_overlap" });
    // The reason names the instant that was holding the slot, so the ledger
    // explains itself without a join.
    // Stable UTC formatting, so the reason does not depend on the writing
    // connection's time zone.
    expect(blocked.stored.skipReason).toBe("overlap:2026-08-01T10:00:00Z");
    // The occurrence that holds the slot is untouched.
    expect((await getOccurrence(db, SCHEDULE_ID, AT_10))?.pending).toBe(true);
  });

  it("lets a different schedule hold its own pending occurrence", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    const other = await acceptOccurrence(
      db,
      admitted(AT_10, { scheduleId: OTHER_SCHEDULE_ID }),
    );
    expect(other.admitted).toBe(true);
  });

  it("refuses an occurrence pinned to a version that does not exist", async () => {
    const error = await acceptOccurrence(
      db,
      admitted(AT_10, { definitionVersion: 99 }),
    ).catch((e: unknown) => e);
    expect(causeMessage(error)).toContain("schedule_occurrences_definition_version_fk");
  });
});

describe("supersedePendingThenAccept", () => {
  it("settles the waiting occurrence rather than mutating it, and queues the newest", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    const result = await supersedePendingThenAccept(db, admitted(AT_11));

    expect(result.admitted).toBe(true);
    expect({
      occurrenceAt: result.stored.occurrenceAt,
      pending: result.stored.pending,
    }).toEqual({ occurrenceAt: AT_11, pending: true });
    expect(result.stored.droppedCount).toBe(1);

    const old = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({
      occurrenceAt: old?.occurrenceAt,
      outcome: old?.outcome,
      pending: old?.pending,
    }).toEqual({ occurrenceAt: AT_10, outcome: "superseded", pending: false });
  });

  it("accumulates dropped_count across a collapsed backlog", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await supersedePendingThenAccept(db, admitted(AT_11));
    const third = await supersedePendingThenAccept(db, admitted(AT_12));
    expect(third.stored.droppedCount).toBe(2);
    expect((await getOccurrence(db, SCHEDULE_ID, AT_11))?.outcome).toBe("superseded");
  });

  it("adds the evaluator's own backlog to the superseded count and carries the cap", async () => {
    await acceptOccurrence(
      db,
      admitted(AT_10, { droppedOlder: 4, droppedOlderAtLeast: true }),
    );
    const result = await supersedePendingThenAccept(
      db,
      admitted(AT_11, { droppedOlder: 2, droppedOlderAtLeast: false }),
    );
    // 2 passed over by this evaluation, plus the superseded row itself, plus the 4
    // that row already stood for.
    expect(result.stored.droppedCount).toBe(7);
    // The cap flag survives from the superseded row even though this admission was
    // exact, because the total is now a floor.
    expect(result.stored.droppedCountCapped).toBe(true);
  });

  it("just admits the occurrence when nothing is waiting", async () => {
    const result = await supersedePendingThenAccept(db, admitted(AT_10));
    expect(result.admitted).toBe(true);
    expect({
      pending: result.stored.pending,
      droppedCount: result.stored.droppedCount,
    }).toEqual({ pending: true, droppedCount: 0 });
  });

  it("does not supersede itself, and does not re-admit, when replayed", async () => {
    await supersedePendingThenAccept(db, admitted(AT_10));
    const replay = await supersedePendingThenAccept(db, admitted(AT_10));
    // admitted is a token earned by the call that created the row, not a
    // description of the row it read back. A replay did not admit anything, so it
    // must not be told to dispatch: otherwise every concurrent caller on one
    // instant would each start a 3 to 25 minute agent run off the same occurrence.
    expect(replay.admitted).toBe(false);
    expect({
      pending: replay.stored.pending,
      outcome: replay.stored.outcome,
      droppedCount: replay.stored.droppedCount,
    }).toEqual({ pending: true, outcome: null, droppedCount: 0 });
  });

  it("refuses to let an older occurrence supersede the one already waiting", async () => {
    await acceptOccurrence(db, admitted(AT_12));
    const error = await supersedePendingThenAccept(db, admitted(AT_11)).catch(
      (e: unknown) => e,
    );
    expect(isUniqueViolation(error)).toBe(true);

    const survivor = await getOccurrence(db, SCHEDULE_ID, AT_12);
    expect({ pending: survivor?.pending, outcome: survivor?.outcome }).toEqual({
      pending: true,
      outcome: null,
    });
    expect(await getOccurrence(db, SCHEDULE_ID, AT_11)).toBeNull();
  });

  it("leaves another schedule's pending occurrence alone", async () => {
    await acceptOccurrence(db, admitted(AT_10, { scheduleId: OTHER_SCHEDULE_ID }));
    await supersedePendingThenAccept(db, admitted(AT_11));
    const other = await getOccurrence(db, OTHER_SCHEDULE_ID, AT_10);
    expect({ pending: other?.pending, outcome: other?.outcome }).toEqual({
      pending: true,
      outcome: null,
    });
  });

  it("reports a settled occurrence as not ours to dispatch", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_stale");
    const replay = await supersedePendingThenAccept(db, admitted(AT_10));
    expect(replay.admitted).toBe(false);
    expect(replay.stored.outcome).toBe("skipped_stale");
  });
});

describe("recordOccurrenceStarted", () => {
  it("refuses to publish a start the caller does not own", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    expect(
      await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1"),
    ).toBe(false);
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({ pending: stored?.pending, outcome: stored?.outcome }).toEqual({
      pending: true,
      outcome: null,
    });
  });

  it("publishes the start, releases the slot, and records the firing on the schedule", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await reserve("owner-1");
    expect(
      await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1"),
    ).toBe(true);
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({
      pending: stored?.pending,
      outcome: stored?.outcome,
      runId: stored?.runId,
    }).toEqual({ pending: false, outcome: "started", runId: "run-1" });
    expect(stored?.dispatchedAt).not.toBeNull();

    // The schedule row carries the truthful "last run", and it is the only record
    // of a firing that outlives the ledger's retention window.
    const schedule = (
      await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, SCHEDULE_ID))
    )[0]!;
    expect({
      lastStartedOccurrenceAt: schedule.lastStartedOccurrenceAt,
      lastStartedRunId: schedule.lastStartedRunId,
    }).toEqual({ lastStartedOccurrenceAt: AT_10, lastStartedRunId: "run-1" });
  });

  it("keeps the last started occurrence monotonic", async () => {
    await acceptOccurrence(db, admitted(AT_11));
    await reserve("owner-1");
    await recordOccurrenceStarted(db, SCHEDULE_ID, AT_11, "owner-1", "run-newer");
    // A late publication for an older occurrence must not rewind what a UI shows.
    await acceptOccurrence(db, admitted(AT_09));
    await recordOccurrenceStarted(db, SCHEDULE_ID, AT_09, "owner-1", "run-older");
    const schedule = (
      await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, SCHEDULE_ID))
    )[0]!;
    expect(schedule.lastStartedOccurrenceAt).toEqual(AT_11);
    expect(schedule.lastStartedRunId).toBe("run-newer");
  });

  it("is idempotent for the same run and keeps the first dispatch instant", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await reserve("owner-1");
    await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1");

    // Pinned to a fixed instant far from now() between the two calls. Comparing
    // two back-to-back now() writes would not test anything: they land in the
    // same millisecond most of the time, so a bare now() in place of the coalesce
    // would pass by luck and flake the rest of the time.
    const pinned = new Date("2026-07-15T08:30:00.000Z");
    await pinDispatchedAt(AT_10, pinned);

    expect(
      await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1"),
    ).toBe(true);
    const second = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect(second?.dispatchedAt).toEqual(pinned);
  });

  it("refuses to publish against a subject that is being cancelled", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await db.insert(activeRuns).values({
      subjectKey: "schedule:sch_test",
      ownerToken: "owner-1",
      runId: "run-1",
      state: "cancelling",
    });
    expect(
      await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1"),
    ).toBe(false);
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({ pending: stored?.pending, outcome: stored?.outcome }).toEqual({
      pending: true,
      outcome: null,
    });
  });

  it("refuses to publish against a parked run", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await db.insert(activeRuns).values({
      subjectKey: "schedule:sch_test",
      ownerToken: "owner-1",
      runId: "run-1",
      state: "parked",
    });
    expect(
      await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1"),
    ).toBe(false);
    expect((await getOccurrence(db, SCHEDULE_ID, AT_10))?.outcome).toBeNull();
  });

  it("refuses to overwrite a different run's published start", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await reserve("owner-1");
    await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1");
    await reserve("owner-2", "schedule:sch_test:2");
    expect(
      await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-2", "run-2"),
    ).toBe(false);
    expect((await getOccurrence(db, SCHEDULE_ID, AT_10))?.runId).toBe("run-1");
  });

  // Settled is terminal. Each of these would otherwise let a run be published
  // over a decision that was already made, and the cancelled case is what makes
  // pausing a schedule a real stop rather than a delay.
  for (const outcome of ["cancelled", "expired", "superseded"] as const) {
    it(`refuses to resurrect a ${outcome} occurrence into a run`, async () => {
      await acceptOccurrence(db, admitted(AT_10));
      await settle(AT_10, outcome);
      await reserve("owner-1");
      expect(
        await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1"),
      ).toBe(false);
      const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
      expect({ outcome: stored?.outcome, runId: stored?.runId }).toEqual({
        outcome,
        runId: null,
      });
    });
  }

  it("still starts an occurrence that failed an earlier attempt", async () => {
    // An errored row is pending, so it is NOT settled and the drain must be able
    // to retry it. Otherwise one transient provider failure would strand the
    // occurrence until it expired.
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceError(db, SCHEDULE_ID, AT_10, "sandbox provider down");
    await reserve("owner-1");
    expect(
      await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1"),
    ).toBe(true);
    expect((await getOccurrence(db, SCHEDULE_ID, AT_10))?.outcome).toBe("started");
  });
});

describe("recordOccurrenceSkipped", () => {
  it("settles the occurrence with the run that blocked it", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    expect(
      await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_overlap", {
        skipReason: "subject_busy",
        blockingRunId: "run-9",
      }),
    ).toBe(true);
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({
      pending: stored?.pending,
      outcome: stored?.outcome,
      skipReason: stored?.skipReason,
      blockingRunId: stored?.blockingRunId,
    }).toEqual({
      pending: false,
      outcome: "skipped_overlap",
      skipReason: "subject_busy",
      blockingRunId: "run-9",
    });
  });

  it("reports false for an occurrence that does not exist", async () => {
    // A silent void return let a write against the wrong key look like a success.
    expect(await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_stale")).toBe(
      false,
    );
  });

  it("never erases the reason an earlier attempt recorded", async () => {
    // Otherwise the operator reads "skipped_overlap" with no reason and goes
    // looking for an overlap, when the truth was two failed provider attempts.
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceError(db, SCHEDULE_ID, AT_10, "sandbox provider down");
    await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_stale");
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect(stored?.skipReason).toBe("sandbox provider down");
    expect(stored?.attemptCount).toBe(1);
  });

  it("frees the pending slot so the next occurrence can be admitted", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_stale");
    const next = await acceptOccurrence(db, admitted(AT_11));
    expect(next.admitted).toBe(true);
  });

  it("cannot overwrite a published start", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await reserve("owner-1");
    await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1");
    expect(
      await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_overlap"),
    ).toBe(false);
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({ outcome: stored?.outcome, runId: stored?.runId }).toEqual({
      outcome: "started",
      runId: "run-1",
    });
  });
});

describe("recordOccurrenceError", () => {
  it("keeps the occurrence pending and counts the attempt", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    expect(
      await recordOccurrenceError(db, SCHEDULE_ID, AT_10, "provider unavailable"),
    ).toBe(true);
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({
      pending: stored?.pending,
      outcome: stored?.outcome,
      skipReason: stored?.skipReason,
      attemptCount: stored?.attemptCount,
    }).toEqual({
      pending: true,
      outcome: "error",
      skipReason: "provider unavailable",
      attemptCount: 1,
    });
    expect(await listPendingOccurrences(db, 10)).toHaveLength(1);
  });

  it("counts every attempt, so a repeatedly failing occurrence is visible", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceError(db, SCHEDULE_ID, AT_10, "first failure");
    await recordOccurrenceError(db, SCHEDULE_ID, AT_10, "second failure");
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    // One text column plus a counter is the whole story: the count is what tells
    // the operator to go and read the logs.
    expect({ attemptCount: stored?.attemptCount, skipReason: stored?.skipReason }).toEqual(
      { attemptCount: 2, skipReason: "second failure" },
    );
  });

  it("cannot overwrite a published start", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await reserve("owner-1");
    await recordOccurrenceStarted(db, SCHEDULE_ID, AT_10, "owner-1", "run-1");
    expect(await recordOccurrenceError(db, SCHEDULE_ID, AT_10, "late failure")).toBe(
      false,
    );
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({ outcome: stored?.outcome, pending: stored?.pending }).toEqual({
      outcome: "started",
      pending: false,
    });
  });
});

describe("recordOccurrenceAtCapacity", () => {
  it("leaves the occurrence waiting instead of settling it", async () => {
    // Capacity is not a decision about the occurrence, it is a reason it has not
    // run yet. Settling it would break the queue policy's promise that a due
    // occurrence waits, and turn a transient shortage into an abandoned run.
    await acceptOccurrence(db, admitted(AT_10));
    expect(await recordOccurrenceAtCapacity(db, SCHEDULE_ID, AT_10)).toBe(true);
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({
      pending: stored?.pending,
      outcome: stored?.outcome,
      skipReason: stored?.skipReason,
      attemptCount: stored?.attemptCount,
    }).toEqual({
      pending: true,
      outcome: null,
      skipReason: "at_capacity",
      attemptCount: 1,
    });
    // Still the drain's to pick up on the next tick.
    expect(await listPendingOccurrences(db, 10)).toHaveLength(1);
  });

  it("counts each deferral, so a long wait reads as waiting and not as abandoned", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceAtCapacity(db, SCHEDULE_ID, AT_10);
    await recordOccurrenceAtCapacity(db, SCHEDULE_ID, AT_10);
    await recordOccurrenceAtCapacity(db, SCHEDULE_ID, AT_10);
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({ attemptCount: stored?.attemptCount, pending: stored?.pending }).toEqual({
      attemptCount: 3,
      pending: true,
    });
  });

  it("reports false for an occurrence that is no longer waiting", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_stale");
    expect(await recordOccurrenceAtCapacity(db, SCHEDULE_ID, AT_10)).toBe(false);
  });
});

describe("expirePendingOccurrences", () => {
  const now = new Date("2026-08-03T00:00:00.000Z");

  it("settles a pending occurrence that waited past the age ceiling", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await backdate(AT_10, new Date(now.getTime() - 25 * 60 * 60 * 1000));
    expect(await expirePendingOccurrences(db, now)).toBe(1);
    const stored = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({ pending: stored?.pending, outcome: stored?.outcome }).toEqual({
      pending: false,
      outcome: "expired",
    });
  });

  it("leaves an occurrence that has waited less than a day", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await backdate(AT_10, new Date(now.getTime() - 23 * 60 * 60 * 1000));
    expect(await expirePendingOccurrences(db, now)).toBe(0);
    expect((await getOccurrence(db, SCHEDULE_ID, AT_10))?.pending).toBe(true);
  });

  it("measures the wait from admission, not from the occurrence instant", async () => {
    // A catch-up admits an occurrence whose instant is already old on purpose.
    // It must still get its turn at the drain: only the evaluator decides that an
    // old instant is not worth firing, and it records that as skipped_stale.
    await acceptOccurrence(db, admitted(new Date("2026-07-01T00:00:00.000Z")));
    expect(await expirePendingOccurrences(db, now)).toBe(0);
  });

  it("carries enough facts to tell a stalled drain from one that never tried", async () => {
    // Reaching the ceiling is a guard, not a diagnosis, so the row itself has to
    // answer which of the two happened.
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceError(db, SCHEDULE_ID, AT_10, "sandbox provider down");
    await backdate(AT_10, new Date(now.getTime() - 25 * 60 * 60 * 1000));
    await acceptOccurrence(db, admitted(AT_11, { scheduleId: OTHER_SCHEDULE_ID }));
    await backdate(AT_11, new Date(now.getTime() - 25 * 60 * 60 * 1000));

    await expirePendingOccurrences(db, now);

    const tried = await getOccurrence(db, SCHEDULE_ID, AT_10);
    expect({ attemptCount: tried?.attemptCount, skipReason: tried?.skipReason }).toEqual({
      attemptCount: 1,
      skipReason: "sandbox provider down",
    });
    const untouched = await getOccurrence(db, OTHER_SCHEDULE_ID, AT_11);
    expect({
      attemptCount: untouched?.attemptCount,
      skipReason: untouched?.skipReason,
    }).toEqual({ attemptCount: 0, skipReason: "expired_before_dispatch" });
  });
});

describe("listPendingOccurrences", () => {
  it("returns waiting occurrences oldest first, bounded by the limit", async () => {
    await acceptOccurrence(db, admitted(AT_11));
    await acceptOccurrence(db, admitted(AT_10, { scheduleId: OTHER_SCHEDULE_ID }));
    const all = await listPendingOccurrences(db, 10);
    expect(all.map((row) => row.occurrenceAt)).toEqual([AT_10, AT_11]);
    expect(await listPendingOccurrences(db, 1)).toHaveLength(1);
  });

  it("excludes settled occurrences", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_stale");
    expect(await listPendingOccurrences(db, 10)).toEqual([]);
  });

  it("serves nothing for a paused schedule", async () => {
    // The drain must not start work for a schedule the customer stopped, even if
    // a race left a pending row behind after the pause cancelled what it found.
    await acceptOccurrence(db, admitted(AT_10));
    await db
      .update(workflowSchedules)
      .set({ pausedAt: new Date("2026-08-01T10:30:00.000Z") })
      .where(eq(workflowSchedules.id, SCHEDULE_ID));
    expect(await listPendingOccurrences(db, 10)).toEqual([]);
  });

  it("serves nothing for a revoked schedule", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await db
      .update(workflowSchedules)
      .set({ revokedAt: new Date("2026-08-01T10:30:00.000Z") })
      .where(eq(workflowSchedules.id, SCHEDULE_ID));
    expect(await listPendingOccurrences(db, 10)).toEqual([]);
  });
});

describe("listOccurrencesForSchedule", () => {
  it("returns one schedule's ledger newest first, bounded", async () => {
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_stale");
    await acceptOccurrence(db, admitted(AT_11));
    await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_11, "skipped_stale");
    await acceptOccurrence(db, admitted(AT_12));
    await acceptOccurrence(db, admitted(AT_09, { scheduleId: OTHER_SCHEDULE_ID }));

    const rows = await listOccurrencesForSchedule(db, SCHEDULE_ID, 10);
    expect(rows.map((row) => row.occurrenceAt)).toEqual([AT_12, AT_11, AT_10]);
    expect(await listOccurrencesForSchedule(db, SCHEDULE_ID, 2)).toHaveLength(2);
  });
});

describe("sweepSettledOccurrences", () => {
  const now = new Date("2026-10-01T00:00:00.000Z");
  const ancient = new Date("2026-08-01T00:00:00.000Z");

  /** Settled rows, all admitted long ago, newest instant last. */
  async function seedSettled(count: number, scheduleId = SCHEDULE_ID): Promise<void> {
    await db.insert(scheduleOccurrences).values(
      Array.from({ length: count }, (_, index) => ({
        scheduleId,
        occurrenceAt: new Date(Date.UTC(2026, 6, 1, index)),
        definitionId: 9,
        definitionVersion: 3,
        pending: false,
        outcome: "skipped_overlap",
        createdAt: ancient,
      })),
    );
  }

  it("drops settled occurrences past the retention window", async () => {
    await seedSettled(25);
    await sweepSettledOccurrences(db, now);
    // Only the newest 20 survive, so the oldest 5 are gone.
    expect(await listOccurrencesForSchedule(db, SCHEDULE_ID, 100)).toHaveLength(20);
  });

  it("never deletes a schedule's newest occurrences, whatever their age", async () => {
    // A weekly schedule has only a handful of rows and every one of them is older
    // than the window, so age alone would erase its entire visible history. For
    // most outcomes this table is the only home there is.
    await seedSettled(3);
    await sweepSettledOccurrences(db, now);
    expect(await listOccurrencesForSchedule(db, SCHEDULE_ID, 100)).toHaveLength(3);
  });

  it("keeps the floor per schedule rather than globally", async () => {
    await seedSettled(25);
    await seedSettled(3, OTHER_SCHEDULE_ID);
    await sweepSettledOccurrences(db, now);
    expect(await listOccurrencesForSchedule(db, SCHEDULE_ID, 100)).toHaveLength(20);
    expect(await listOccurrencesForSchedule(db, OTHER_SCHEDULE_ID, 100)).toHaveLength(3);
  });

  it("never deletes a pending occurrence, whatever its age", async () => {
    // Deleting it would strand work the drain still owns, and deleting the dedupe
    // key would let the same occurrence be admitted and dispatched a second time.
    await seedSettled(25);
    await acceptOccurrence(db, admitted(AT_10));
    await backdate(AT_10, ancient);
    await sweepSettledOccurrences(db, now);
    expect((await getOccurrence(db, SCHEDULE_ID, AT_10))?.pending).toBe(true);
  });

  it("keeps a settled occurrence inside the retention window", async () => {
    await seedSettled(25);
    await acceptOccurrence(db, admitted(AT_10));
    await recordOccurrenceSkipped(db, SCHEDULE_ID, AT_10, "skipped_overlap");
    await backdate(AT_10, new Date(now.getTime() - 24 * 60 * 60 * 1000));
    await sweepSettledOccurrences(db, now);
    expect(await getOccurrence(db, SCHEDULE_ID, AT_10)).not.toBeNull();
  });

  it("retains for thirty days, not one week", async () => {
    // Pins the window itself, isolated from the newest-per-schedule floor. This
    // row sits outside the floor (it is one of the oldest instants) but was
    // admitted only ten days ago, so age is the ONLY thing that can save it. A
    // seven day window would delete it; for most outcomes this table is the only
    // record there is, so a week is not long enough to investigate anything.
    await seedSettled(25);
    const oldestInstant = new Date(Date.UTC(2026, 6, 1, 0));
    await db
      .update(scheduleOccurrences)
      .set({ createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000) })
      .where(eq(scheduleOccurrences.occurrenceAt, oldestInstant));

    await sweepSettledOccurrences(db, now);

    expect(await getOccurrence(db, SCHEDULE_ID, oldestInstant)).not.toBeNull();
    // The other four rows outside the floor were admitted long ago and do go.
    expect(await listOccurrencesForSchedule(db, SCHEDULE_ID, 100)).toHaveLength(21);
  });
});
