import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  scheduleOccurrences,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowSchedules,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  advanceWatermark,
  getScheduleById,
  listEvaluableSchedules,
  listSchedulesForDefinition,
  mintSchedulesForLiveHead,
  pauseSchedule,
  recordEvaluationPass,
  resumeSchedule,
  revokeSchedule,
  type MintableScheduleNode,
} from "./schedule-store.js";

/** The definition every test mints schedules against. */
const DEFINITION_ID = 9;

function scheduleNode(
  id: string,
  configuration: Record<string, unknown> = {},
): MintableScheduleNode {
  return { id, type: "trigger_schedule", configuration };
}

async function allSchedules(db: Db) {
  return db.select().from(workflowSchedules);
}

/** Mints a single "sched" node and returns its result, so a test that only
 *  cares about one schedule does not repeat the definitionId/nodes wrapper. */
async function mintOne(
  configuration: Record<string, unknown> = { cron: "0 * * * *" },
  now?: Date,
) {
  const [minted] = await mintSchedulesForLiveHead(
    db,
    { definitionId: DEFINITION_ID, nodes: [scheduleNode("sched", configuration)] },
    now,
  );
  return minted!;
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(workflowDefinitions).values({
    id: DEFINITION_ID,
    name: "Scheduled flow",
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowDefinitionVersions).values({
    definitionId: DEFINITION_ID,
    version: 3,
    definition: {},
    createdById: "test",
    createdByLabel: "Test",
  });
});

/** A pending occurrence for a schedule, so a pause has something to cancel. */
async function seedPendingOccurrence(
  scheduleId: string,
  occurrenceAt: Date,
): Promise<void> {
  await db.insert(scheduleOccurrences).values({
    scheduleId,
    occurrenceAt,
    definitionId: DEFINITION_ID,
    definitionVersion: 3,
    pending: true,
  });
}

describe("mintSchedulesForLiveHead", () => {
  it("mints one row per trigger_schedule node and ignores other node types", async () => {
    const minted = await mintSchedulesForLiveHead(db, {
      definitionId: DEFINITION_ID,
      nodes: [
        scheduleNode("sched_a", { cron: "0 * * * *" }),
        { id: "agent", type: "planning_agent" },
        scheduleNode("sched_b", { cron: "0 0 * * *" }),
      ],
    });

    expect(minted.map((entry) => entry.nodeId)).toEqual(["sched_a", "sched_b"]);
    expect(minted.every((entry) => entry.minted)).toBe(true);
    expect(minted[0]!.scheduleId).toMatch(/^sch_[0-9a-f]{24}$/);
    expect(minted[0]!.scheduleId).not.toBe(minted[1]!.scheduleId);

    const rows = await allSchedules(db);
    expect(rows).toHaveLength(2);
  });

  it("applies config defaults when timezone, overlapPolicy and catchUpGraceMinutes are omitted", async () => {
    const minted = await mintOne({ cron: "0 * * * *" });

    const row = await getScheduleById(db, minted.scheduleId);
    expect(row).toMatchObject({
      cron: "0 * * * *",
      timezone: "UTC",
      overlapPolicy: "skip",
      catchUpGraceMinutes: 60,
    });
  });

  it("falls back to config defaults when the authored values are of the wrong type", async () => {
    const minted = await mintOne({
      cron: "0 * * * *",
      timezone: 42,
      overlapPolicy: "explode",
      catchUpGraceMinutes: "soon",
    });

    const row = await getScheduleById(db, minted.scheduleId);
    expect(row).toMatchObject({
      timezone: "UTC",
      overlapPolicy: "skip",
      catchUpGraceMinutes: 60,
    });
  });

  it("re-syncs the four authored columns on redeploy without clearing the pause or either cursor", async () => {
    const mintNow = new Date("2026-08-01T00:00:00.000Z");
    const first = await mintOne(
      { cron: "0 * * * *", timezone: "UTC", overlapPolicy: "skip", catchUpGraceMinutes: 60 },
      mintNow,
    );

    await pauseSchedule(db, first.scheduleId, new Date("2026-08-02T00:00:00.000Z"));
    const advanced = await advanceWatermark(
      db,
      first.scheduleId,
      new Date("2026-08-03T00:00:00.000Z"),
    );
    expect(advanced).toBe(true);
    await recordEvaluationPass(db, first.scheduleId, new Date("2026-08-04T00:00:00.000Z"));
    await revokeSchedule(db, first.scheduleId, new Date("2026-08-05T00:00:00.000Z"));

    const before = (await getScheduleById(db, first.scheduleId))!;

    // Same node, different authored values: a deploy re-syncs cron, timezone,
    // overlap policy and catch-up grace, but must not revive or reset anything
    // the operator or the evaluator already decided.
    const [second] = await mintSchedulesForLiveHead(
      db,
      {
        definitionId: DEFINITION_ID,
        nodes: [
          scheduleNode("sched", {
            cron: "30 6 * * 1",
            timezone: "Europe/Warsaw",
            overlapPolicy: "queue",
            catchUpGraceMinutes: 15,
          }),
        ],
      },
      new Date("2026-08-06T00:00:00.000Z"),
    );

    expect(second).toEqual({ scheduleId: first.scheduleId, nodeId: "sched", minted: false });

    const after = (await getScheduleById(db, first.scheduleId))!;
    expect(after).toMatchObject({
      id: before.id,
      cron: "30 6 * * 1",
      timezone: "Europe/Warsaw",
      overlapPolicy: "queue",
      catchUpGraceMinutes: 15,
    });
    expect({
      pausedAt: after.pausedAt,
      evaluationWatermarkAt: after.evaluationWatermarkAt,
      lastEvaluatedAt: after.lastEvaluatedAt,
    }).toEqual({
      pausedAt: before.pausedAt,
      evaluationWatermarkAt: before.evaluationWatermarkAt,
      lastEvaluatedAt: before.lastEvaluatedAt,
    });
  });

  it("lifts a revocation when the node is back in the deployed head, keeping the pause", async () => {
    // Revoking only records that the node was absent. A deploy carrying the node
    // has answered that, so the revocation must clear or a paused schedule whose
    // node was removed and restored would be wedged with no way out: no deploy
    // could lift it and there is no unrevoke endpoint.
    const first = await mintOne();
    await pauseSchedule(db, first.scheduleId, new Date("2026-08-02T00:00:00.000Z"));
    await revokeSchedule(db, first.scheduleId, new Date("2026-08-03T00:00:00.000Z"));

    await mintOne();

    const after = (await getScheduleById(db, first.scheduleId))!;
    expect(after.revokedAt).toBeNull();
    // The pause is a human intention, so it is sticky where the revocation is not.
    expect(after.pausedAt).toEqual(new Date("2026-08-02T00:00:00.000Z"));
  });

  it("mints a new row with evaluationWatermarkAt set to the given now, never null", async () => {
    const mintNow = new Date("2026-08-01T12:00:00.000Z");
    const minted = await mintOne({ cron: "0 * * * *" }, mintNow);

    const row = (await getScheduleById(db, minted.scheduleId))!;
    expect(row.evaluationWatermarkAt).not.toBeNull();
    expect(row.evaluationWatermarkAt).toEqual(mintNow);
  });
});

describe("resumeSchedule", () => {
  it("clears pausedAt and parks the watermark one grace window behind now", async () => {
    // A resume behaves exactly like a scheduler outage of the same length: an
    // occurrence still inside the catch-up grace is caught up, older ones are
    // forgotten. Parking the watermark at now instead would discard an occurrence
    // five minutes late even though the schedule tolerates sixty.
    const mintNow = new Date("2026-08-01T00:00:00.000Z");
    const minted = await mintOne(
      { cron: "0 * * * *", catchUpGraceMinutes: 60 },
      mintNow,
    );
    await pauseSchedule(db, minted.scheduleId, new Date("2026-08-02T00:00:00.000Z"));

    const resumeNow = new Date("2026-08-10T00:00:00.000Z");
    await resumeSchedule(db, minted.scheduleId, resumeNow);

    const row = (await getScheduleById(db, minted.scheduleId))!;
    expect(row.pausedAt).toBeNull();
    expect(row.evaluationWatermarkAt).toEqual(new Date("2026-08-09T23:00:00.000Z"));
  });

  it("reads the grace window from the schedule's own configuration", async () => {
    const minted = await mintOne(
      { cron: "0 * * * *", catchUpGraceMinutes: 15 },
      new Date("2026-08-01T00:00:00.000Z"),
    );
    await pauseSchedule(db, minted.scheduleId, new Date("2026-08-02T00:00:00.000Z"));

    await resumeSchedule(db, minted.scheduleId, new Date("2026-08-10T00:00:00.000Z"));

    const row = (await getScheduleById(db, minted.scheduleId))!;
    expect(row.evaluationWatermarkAt).toEqual(new Date("2026-08-09T23:45:00.000Z"));
  });

  it("is a no-op on a schedule that is not paused, leaving the watermark alone", async () => {
    const mintNow = new Date("2026-08-01T00:00:00.000Z");
    const minted = await mintOne({ cron: "0 * * * *" }, mintNow);

    // The row was never paused: a resume here would otherwise skip every
    // occurrence between the watermark and this later instant.
    await resumeSchedule(db, minted.scheduleId, new Date("2026-08-10T00:00:00.000Z"));

    const row = (await getScheduleById(db, minted.scheduleId))!;
    expect(row.pausedAt).toBeNull();
    expect(row.evaluationWatermarkAt).toEqual(mintNow);
  });
});

describe("pauseSchedule", () => {
  it("cancels the occurrence that was waiting, so pause is a stop and not a delay", async () => {
    // An occurrence already admitted but not started is exactly what a customer
    // presses pause to prevent. Leaving it pending would let the drain start it
    // moments later, on a schedule the customer believes is stopped.
    const minted = await mintOne();
    const waiting = new Date("2026-08-01T09:00:00.000Z");
    await seedPendingOccurrence(minted.scheduleId, waiting);

    await pauseSchedule(db, minted.scheduleId, new Date("2026-08-01T09:30:00.000Z"));

    const occurrence = (
      await db
        .select()
        .from(scheduleOccurrences)
        .where(eq(scheduleOccurrences.occurrenceAt, waiting))
    )[0]!;
    expect({
      pending: occurrence.pending,
      outcome: occurrence.outcome,
      skipReason: occurrence.skipReason,
    }).toEqual({
      pending: false,
      outcome: "cancelled",
      skipReason: "schedule_paused",
    });
  });

  it("cancels a waiting occurrence even when the schedule is already paused", async () => {
    const minted = await mintOne();
    await pauseSchedule(db, minted.scheduleId, new Date("2026-08-01T09:00:00.000Z"));
    const waiting = new Date("2026-08-01T09:30:00.000Z");
    await seedPendingOccurrence(minted.scheduleId, waiting);

    await pauseSchedule(db, minted.scheduleId, new Date("2026-08-01T10:00:00.000Z"));

    const occurrence = (
      await db
        .select()
        .from(scheduleOccurrences)
        .where(eq(scheduleOccurrences.occurrenceAt, waiting))
    )[0]!;
    expect(occurrence.outcome).toBe("cancelled");
  });

  it("keeps the first pause instant when paused twice", async () => {
    const minted = await mintOne();
    const firstPause = new Date("2026-08-01T00:00:00.000Z");
    await pauseSchedule(db, minted.scheduleId, firstPause);

    await pauseSchedule(db, minted.scheduleId, new Date("2026-08-02T00:00:00.000Z"));

    const row = (await getScheduleById(db, minted.scheduleId))!;
    expect(row.pausedAt).toEqual(firstPause);
  });
});

describe("revokeSchedule", () => {
  it("keeps the first revocation instant when revoked twice", async () => {
    const minted = await mintOne();
    const firstRevoke = new Date("2026-08-01T00:00:00.000Z");
    await revokeSchedule(db, minted.scheduleId, firstRevoke);

    await revokeSchedule(db, minted.scheduleId, new Date("2026-08-02T00:00:00.000Z"));

    const row = (await getScheduleById(db, minted.scheduleId))!;
    expect(row.revokedAt).toEqual(firstRevoke);
  });
});

describe("advanceWatermark", () => {
  it("moves the watermark forward and returns true", async () => {
    const mintNow = new Date("2026-08-01T00:00:00.000Z");
    const minted = await mintOne({ cron: "0 * * * *" }, mintNow);

    const moved = await advanceWatermark(
      db,
      minted.scheduleId,
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(moved).toBe(true);
    const row = (await getScheduleById(db, minted.scheduleId))!;
    expect(row.evaluationWatermarkAt).toEqual(new Date("2026-08-02T00:00:00.000Z"));
  });

  it("refuses to rewind for an instant at or behind the stored watermark", async () => {
    const mintNow = new Date("2026-08-05T00:00:00.000Z");
    const minted = await mintOne({ cron: "0 * * * *" }, mintNow);

    // Exactly the stored watermark: not an advance, so it must not report one.
    expect(await advanceWatermark(db, minted.scheduleId, mintNow)).toBe(false);
    // Strictly behind the stored watermark: the classic out-of-order tick.
    expect(
      await advanceWatermark(db, minted.scheduleId, new Date("2026-08-01T00:00:00.000Z")),
    ).toBe(false);

    const row = (await getScheduleById(db, minted.scheduleId))!;
    expect(row.evaluationWatermarkAt).toEqual(mintNow);
  });
});

describe("recordEvaluationPass", () => {
  it("sets lastEvaluatedAt without touching evaluationWatermarkAt", async () => {
    const mintNow = new Date("2026-08-01T00:00:00.000Z");
    const minted = await mintOne({ cron: "0 * * * *" }, mintNow);

    const evalNow = new Date("2026-08-02T00:00:00.000Z");
    await recordEvaluationPass(db, minted.scheduleId, evalNow);

    const row = (await getScheduleById(db, minted.scheduleId))!;
    expect(row.lastEvaluatedAt).toEqual(evalNow);
    expect(row.evaluationWatermarkAt).toEqual(mintNow);
  });
});

describe("listEvaluableSchedules", () => {
  it("excludes paused and revoked schedules", async () => {
    const minted = await mintSchedulesForLiveHead(db, {
      definitionId: DEFINITION_ID,
      nodes: [
        scheduleNode("live", { cron: "0 * * * *" }),
        scheduleNode("paused", { cron: "0 * * * *" }),
        scheduleNode("revoked", { cron: "0 * * * *" }),
      ],
    });
    const [live, paused, revoked] = minted;
    await pauseSchedule(db, paused!.scheduleId);
    await revokeSchedule(db, revoked!.scheduleId);

    const evaluable = await listEvaluableSchedules(db, 10);

    expect(evaluable.map((row) => row.id)).toEqual([live!.scheduleId]);
  });

  it("orders least recently evaluated first, with never-evaluated schedules ahead of evaluated ones", async () => {
    const minted = await mintSchedulesForLiveHead(db, {
      definitionId: DEFINITION_ID,
      nodes: [
        scheduleNode("evaluated_recent", { cron: "0 * * * *" }),
        scheduleNode("never_evaluated", { cron: "0 * * * *" }),
        scheduleNode("evaluated_old", { cron: "0 * * * *" }),
      ],
    });
    const [recent, never, old] = minted;
    await recordEvaluationPass(db, recent!.scheduleId, new Date("2026-08-05T00:00:00.000Z"));
    await recordEvaluationPass(db, old!.scheduleId, new Date("2026-08-01T00:00:00.000Z"));
    // "never" is left alone: lastEvaluatedAt stays null.

    const evaluable = await listEvaluableSchedules(db, 10);

    expect(evaluable.map((row) => row.id)).toEqual([
      never!.scheduleId,
      old!.scheduleId,
      recent!.scheduleId,
    ]);
  });

  it("honours the limit", async () => {
    await mintSchedulesForLiveHead(db, {
      definitionId: DEFINITION_ID,
      nodes: [
        scheduleNode("a", { cron: "0 * * * *" }),
        scheduleNode("b", { cron: "0 * * * *" }),
        scheduleNode("c", { cron: "0 * * * *" }),
      ],
    });

    const evaluable = await listEvaluableSchedules(db, 2);

    expect(evaluable).toHaveLength(2);
  });
});

describe("listSchedulesForDefinition", () => {
  it("returns revoked rows too", async () => {
    const minted = await mintOne();
    await revokeSchedule(db, minted.scheduleId);

    const rows = await listSchedulesForDefinition(db, DEFINITION_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).not.toBeNull();
  });
});
