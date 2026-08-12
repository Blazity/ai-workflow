import { beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { triggerRateLimits, triggerRejectionCounters } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  checkAndIncrementTriggerRate,
  enforceTriggerRateLimit,
  getTriggerRejectionsToday,
  recordTriggerRejection,
  resolveRestrictiveTriggerRateLimit,
  resolveTriggerRateLimit,
  resolveTriggerRateLimitForType,
  sweepTriggerRateLimits,
  sweepTriggerRejectionCounters,
  triggerRateWindowEnd,
  triggerRateWindowStart,
} from "./trigger-rate-limit.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

const keyA = { definitionId: "def_1", nodeId: "node_a" };
const keyB = { definitionId: "def_1", nodeId: "node_b" };

const inWindow = new Date("2026-02-01T10:00:31.500Z");
const nextWindow = new Date("2026-02-01T10:01:00.000Z");

describe("triggerRateWindowStart", () => {
  it("floors minute, hour and day windows on the UTC clock", () => {
    expect(triggerRateWindowStart("minute", inWindow)).toEqual(
      new Date("2026-02-01T10:00:00.000Z"),
    );
    expect(triggerRateWindowStart("hour", inWindow)).toEqual(
      new Date("2026-02-01T10:00:00.000Z"),
    );
    expect(triggerRateWindowStart("day", inWindow)).toEqual(
      new Date("2026-02-01T00:00:00.000Z"),
    );
    expect(triggerRateWindowStart("hour", new Date("2026-02-01T10:59:59.999Z"))).toEqual(
      new Date("2026-02-01T10:00:00.000Z"),
    );
  });

  it("treats month as the UTC calendar month, not a rolling 30 days", () => {
    expect(triggerRateWindowStart("month", new Date("2026-08-31T23:00:00.000Z"))).toEqual(
      new Date("2026-08-01T00:00:00.000Z"),
    );
    expect(triggerRateWindowStart("month", new Date("2026-09-01T00:30:00.000Z"))).toEqual(
      new Date("2026-09-01T00:00:00.000Z"),
    );
  });
});

describe("checkAndIncrementTriggerRate", () => {
  it("allows starts up to the limit and refuses at and past it", async () => {
    const decisions = [];
    for (let start = 0; start < 4; start += 1) {
      decisions.push(await checkAndIncrementTriggerRate(db, keyA, "minute", 2, inWindow));
    }

    expect(decisions).toEqual([
      { allowed: true, count: 1 },
      { allowed: true, count: 2 },
      { allowed: false, count: 3 },
      { allowed: false, count: 4 },
    ]);
  });

  it("counts keys independently across nodes and definitions", async () => {
    await checkAndIncrementTriggerRate(db, keyA, "minute", 1, inWindow);
    await expect(
      checkAndIncrementTriggerRate(db, keyA, "minute", 1, inWindow),
    ).resolves.toEqual({ count: 2, allowed: false });

    await expect(
      checkAndIncrementTriggerRate(db, keyB, "minute", 1, inWindow),
    ).resolves.toEqual({ count: 1, allowed: true });
    await expect(
      checkAndIncrementTriggerRate(db, { definitionId: "def_2", nodeId: "node_a" }, "minute", 1, inWindow),
    ).resolves.toEqual({ count: 1, allowed: true });
  });

  it("starts a fresh count in the next window, so a burst on the boundary is allowed", async () => {
    await checkAndIncrementTriggerRate(db, keyA, "minute", 2, new Date("2026-02-01T10:00:59.000Z"));
    await checkAndIncrementTriggerRate(db, keyA, "minute", 2, new Date("2026-02-01T10:00:59.500Z"));
    await expect(
      checkAndIncrementTriggerRate(db, keyA, "minute", 2, new Date("2026-02-01T10:00:59.750Z")),
    ).resolves.toEqual({ count: 3, allowed: false });

    // Fixed window: the same limit is available again from the first
    // millisecond of the next window.
    await expect(
      checkAndIncrementTriggerRate(db, keyA, "minute", 2, nextWindow),
    ).resolves.toEqual({ count: 1, allowed: true });
    await expect(
      checkAndIncrementTriggerRate(db, keyA, "minute", 2, new Date("2026-02-01T10:01:00.500Z")),
    ).resolves.toEqual({ count: 2, allowed: true });
  });

  it("resets the monthly counter on the UTC calendar boundary", async () => {
    const august = new Date("2026-08-31T23:00:00.000Z");
    await checkAndIncrementTriggerRate(db, keyA, "month", 1, august);
    await expect(
      checkAndIncrementTriggerRate(db, keyA, "month", 1, august),
    ).resolves.toEqual({ count: 2, allowed: false });

    await expect(
      checkAndIncrementTriggerRate(db, keyA, "month", 1, new Date("2026-09-01T00:30:00.000Z")),
    ).resolves.toEqual({ count: 1, allowed: true });
  });

  it("keeps windows of different kinds in separate rows", async () => {
    await checkAndIncrementTriggerRate(db, keyA, "hour", 1, inWindow);
    await checkAndIncrementTriggerRate(db, keyA, "day", 5, inWindow);

    await expect(
      db.select().from(triggerRateLimits).orderBy(asc(triggerRateLimits.windowStart)),
    ).resolves.toMatchObject([
      { windowKind: "day", windowStart: new Date("2026-02-01T00:00:00.000Z"), count: 1 },
      { windowKind: "hour", windowStart: new Date("2026-02-01T10:00:00.000Z"), count: 1 },
    ]);
  });

  /**
   * The one instant where every window kind floors to the SAME window_start, so
   * the kind is the only thing separating the four counters. Keyed on the start
   * alone, all four starts below would land on one row: the second call would
   * report count 2 and refuse a limit of 1 that nothing had spent, and an
   * operator who moved a node from monthly to hourly at midnight would inherit
   * the month's tally.
   */
  it("keeps all four kinds independent at a boundary they share", async () => {
    const boundary = new Date("2026-09-01T00:00:00.000Z");

    for (const windowKind of ["minute", "hour", "day", "month"] as const) {
      await expect(
        checkAndIncrementTriggerRate(db, keyA, windowKind, 1, boundary),
      ).resolves.toEqual({ count: 1, allowed: true });
    }

    const rows = await db
      .select()
      .from(triggerRateLimits)
      .orderBy(asc(triggerRateLimits.windowKind));
    expect(rows).toMatchObject([
      { windowKind: "day", windowStart: boundary, count: 1 },
      { windowKind: "hour", windowStart: boundary, count: 1 },
      { windowKind: "minute", windowStart: boundary, count: 1 },
      { windowKind: "month", windowStart: boundary, count: 1 },
    ]);
    // Four rows, one window_start: the composite key really is doing the work.
    expect(new Set(rows.map((row) => row.windowStart.toISOString())).size).toBe(1);

    // And a second start still lands on its own kind's row, not on a sibling's.
    await expect(
      checkAndIncrementTriggerRate(db, keyA, "hour", 1, boundary),
    ).resolves.toEqual({ count: 2, allowed: false });
    await expect(
      checkAndIncrementTriggerRate(db, keyA, "minute", 1, boundary),
    ).resolves.toEqual({ count: 2, allowed: false });
    await expect(
      db
        .select({ windowKind: triggerRateLimits.windowKind, count: triggerRateLimits.count })
        .from(triggerRateLimits)
        .orderBy(asc(triggerRateLimits.windowKind)),
    ).resolves.toEqual([
      { windowKind: "day", count: 1 },
      { windowKind: "hour", count: 2 },
      { windowKind: "minute", count: 2 },
      { windowKind: "month", count: 1 },
    ]);
  });

  it("does not hand a node that changed its window the count it left behind", async () => {
    // 10:00:00 exactly: the minute window and the hour window share a start.
    const onTheHour = new Date("2026-09-01T10:00:00.000Z");
    await checkAndIncrementTriggerRate(db, keyA, "hour", 2, onTheHour);
    await checkAndIncrementTriggerRate(db, keyA, "hour", 2, onTheHour);

    // The operator switches the node to a per-minute limit inside that same
    // minute. The new window starts clean.
    await expect(
      checkAndIncrementTriggerRate(db, keyA, "minute", 2, onTheHour),
    ).resolves.toEqual({ count: 1, allowed: true });
  });
});

describe("resolveTriggerRateLimit", () => {
  it("returns null when nothing is configured, meaning unlimited", () => {
    expect(resolveTriggerRateLimit({}, null)).toBeNull();
    expect(resolveTriggerRateLimit(undefined, undefined)).toBeNull();
  });

  it("falls back to the env default only for fields the node does not set", () => {
    const env = { max: 10, windowKind: "hour" as const };
    expect(resolveTriggerRateLimit({}, env)).toEqual(env);
    expect(resolveTriggerRateLimit({ rateLimitMax: 3 }, env)).toEqual({
      max: 3,
      windowKind: "hour",
    });
    expect(
      resolveTriggerRateLimit({ rateLimitMax: 3, rateLimitWindow: "day" }, env),
    ).toEqual({ max: 3, windowKind: "day" });
  });

  it("treats a partial configuration with no counterpart as unlimited", () => {
    expect(resolveTriggerRateLimit({ rateLimitMax: 3 }, null)).toBeNull();
    expect(resolveTriggerRateLimit({ rateLimitWindow: "day" }, null)).toBeNull();
    expect(
      resolveTriggerRateLimit({ rateLimitWindow: "day" }, { max: 10, windowKind: "hour" }),
    ).toEqual({ max: 10, windowKind: "day" });
  });
});

describe("resolveRestrictiveTriggerRateLimit", () => {
  it("compares mixed windows by their normalized 30-day rate", () => {
    expect(
      resolveRestrictiveTriggerRateLimit(
        [
          { nodeId: "node_a", params: { rateLimitMax: 1, rateLimitWindow: "minute" } },
          { nodeId: "node_b", params: { rateLimitMax: 50, rateLimitWindow: "hour" } },
          { nodeId: "node_c", params: { rateLimitMax: 1_000, rateLimitWindow: "day" } },
          { nodeId: "node_d", params: { rateLimitMax: 25_000, rateLimitWindow: "month" } },
        ],
        null,
      ),
    ).toEqual({ max: 25_000, windowKind: "month", nodeId: "node_d" });
  });

  it("keeps the first candidate when normalized rates tie", () => {
    expect(
      resolveRestrictiveTriggerRateLimit(
        [
          { nodeId: "node_a", params: { rateLimitMax: 1, rateLimitWindow: "minute" } },
          { nodeId: "node_b", params: { rateLimitMax: 60, rateLimitWindow: "hour" } },
          { nodeId: "node_c", params: { rateLimitMax: 1_440, rateLimitWindow: "day" } },
          { nodeId: "node_d", params: { rateLimitMax: 43_200, rateLimitWindow: "month" } },
        ],
        null,
      ),
    ).toEqual({ max: 1, windowKind: "minute", nodeId: "node_a" });
  });

  it("returns null when no node configures a limit and there is no env default", () => {
    expect(
      resolveRestrictiveTriggerRateLimit(
        [
          { nodeId: "node_a", params: {} },
          { nodeId: "node_b", params: {} },
        ],
        null,
      ),
    ).toBeNull();
    expect(resolveRestrictiveTriggerRateLimit([], null)).toBeNull();
  });

  it("reports nodeId null when the winning config comes only from the env default", () => {
    expect(
      resolveRestrictiveTriggerRateLimit(
        [
          { nodeId: "node_a", params: { rateLimitMax: 300, rateLimitWindow: "day" } },
          { nodeId: "node_b", params: {} },
        ],
        { max: 10, windowKind: "hour" },
      ),
    ).toEqual({ max: 10, windowKind: "hour", nodeId: null });
  });

  it("keeps the source nodeId when the node contributes any field of the winning config", () => {
    expect(
      resolveRestrictiveTriggerRateLimit(
        [{ nodeId: "node_a", params: { rateLimitMax: 3 } }],
        { max: 10, windowKind: "hour" },
      ),
    ).toEqual({ max: 3, windowKind: "hour", nodeId: "node_a" });
  });
});

describe("trigger rejection counters", () => {
  const dayOne = new Date("2026-08-31T23:30:00.000Z");
  const dayTwo = new Date("2026-09-01T00:30:00.000Z");

  it("upserts per node, reason and UTC calendar day", async () => {
    await recordTriggerRejection(db, keyA, "rate_limited", dayOne);
    await recordTriggerRejection(db, keyA, "rate_limited", dayOne);
    await recordTriggerRejection(db, keyA, "duplicate", dayOne);
    await recordTriggerRejection(db, keyB, "rate_limited", dayOne);
    await recordTriggerRejection(db, keyA, "rate_limited", dayTwo);

    await expect(
      db
        .select()
        .from(triggerRejectionCounters)
        .orderBy(
          asc(triggerRejectionCounters.day),
          asc(triggerRejectionCounters.nodeId),
          asc(triggerRejectionCounters.reason),
        ),
    ).resolves.toEqual([
      { definitionId: "def_1", nodeId: "node_a", reason: "duplicate", day: "2026-08-31", count: 1 },
      { definitionId: "def_1", nodeId: "node_a", reason: "rate_limited", day: "2026-08-31", count: 2 },
      { definitionId: "def_1", nodeId: "node_b", reason: "rate_limited", day: "2026-08-31", count: 1 },
      { definitionId: "def_1", nodeId: "node_a", reason: "rate_limited", day: "2026-09-01", count: 1 },
    ]);
  });

  it("reads back only today's counters for one node, worst reason first", async () => {
    await recordTriggerRejection(db, keyA, "rate_limited", dayTwo);
    await recordTriggerRejection(db, keyA, "rate_limited", dayTwo);
    await recordTriggerRejection(db, keyA, "duplicate", dayTwo);
    await recordTriggerRejection(db, keyA, "rate_limited", dayOne);
    await recordTriggerRejection(db, keyB, "rate_limited", dayTwo);

    await expect(getTriggerRejectionsToday(db, keyA, dayTwo)).resolves.toEqual([
      { reason: "rate_limited", count: 2 },
      { reason: "duplicate", count: 1 },
    ]);
  });
});

describe("sweeps", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");

  it("sweeps rate-limit windows older than 62 days and keeps the live ones", async () => {
    // Cutoff: 2026-06-10T12:00:00.000Z. A window starting exactly at the
    // cutoff survives (strictly older than 62 days is deleted).
    await checkAndIncrementTriggerRate(db, keyA, "minute", 5, new Date("2026-06-10T10:00:00.000Z"));
    await checkAndIncrementTriggerRate(db, keyA, "minute", 5, new Date("2026-06-10T12:00:00.000Z"));
    await checkAndIncrementTriggerRate(db, keyA, "minute", 5, new Date("2026-08-10T10:00:00.000Z"));

    await sweepTriggerRateLimits(db, now);

    await expect(
      db.select().from(triggerRateLimits).orderBy(asc(triggerRateLimits.windowStart)),
    ).resolves.toMatchObject([
      { windowStart: new Date("2026-06-10T12:00:00.000Z") },
      { windowStart: new Date("2026-08-10T10:00:00.000Z") },
    ]);
  });

  it("sweeps rejection counters older than 30 days and keeps the live ones", async () => {
    // Cutoff day: 2026-07-12. Rows from that day survive (strictly older is
    // deleted), rows from 2026-07-11 do not.
    await recordTriggerRejection(db, keyA, "rate_limited", new Date("2026-07-11T23:30:00.000Z"));
    await recordTriggerRejection(db, keyA, "rate_limited", new Date("2026-07-12T00:30:00.000Z"));
    await recordTriggerRejection(db, keyA, "rate_limited", new Date("2026-08-11T00:30:00.000Z"));

    await sweepTriggerRejectionCounters(db, now);

    await expect(
      db.select().from(triggerRejectionCounters).orderBy(asc(triggerRejectionCounters.day)),
    ).resolves.toMatchObject([{ day: "2026-07-12" }, { day: "2026-08-11" }]);
  });
});

describe("triggerRateWindowEnd", () => {
  it("reports the next window's start, calendar-aware for a month", () => {
    expect(triggerRateWindowEnd("minute", new Date("2026-02-01T10:00:00.000Z"))).toEqual(
      new Date("2026-02-01T10:01:00.000Z"),
    );
    expect(triggerRateWindowEnd("day", new Date("2026-02-01T00:00:00.000Z"))).toEqual(
      new Date("2026-02-02T00:00:00.000Z"),
    );
    // February, and a year boundary: neither is 30 days later.
    expect(triggerRateWindowEnd("month", new Date("2026-02-01T00:00:00.000Z"))).toEqual(
      new Date("2026-03-01T00:00:00.000Z"),
    );
    expect(triggerRateWindowEnd("month", new Date("2026-12-01T00:00:00.000Z"))).toEqual(
      new Date("2027-01-01T00:00:00.000Z"),
    );
  });
});

describe("enforceTriggerRateLimit", () => {
  it("writes nothing at all for an unlimited trigger", async () => {
    await expect(enforceTriggerRateLimit(db, keyA, null, inWindow)).resolves.toBeNull();

    await expect(db.select().from(triggerRateLimits)).resolves.toEqual([]);
    await expect(db.select().from(triggerRejectionCounters)).resolves.toEqual([]);
  });

  it("reports the limit, the count and when the window resets", async () => {
    const decision = await enforceTriggerRateLimit(
      db,
      keyA,
      { max: 2, windowKind: "hour" },
      inWindow,
    );

    expect(decision).toEqual({
      max: 2,
      windowKind: "hour",
      allowed: true,
      count: 1,
      windowStart: new Date("2026-02-01T10:00:00.000Z"),
      resetAt: new Date("2026-02-01T11:00:00.000Z"),
    });
  });

  it("tallies a rejection only once the window is spent", async () => {
    const limit = { max: 1, windowKind: "minute" as const };

    await expect(enforceTriggerRateLimit(db, keyA, limit, inWindow)).resolves.toMatchObject({
      allowed: true,
      count: 1,
    });
    await expect(db.select().from(triggerRejectionCounters)).resolves.toEqual([]);

    await expect(enforceTriggerRateLimit(db, keyA, limit, inWindow)).resolves.toMatchObject({
      allowed: false,
      count: 2,
    });
    await expect(db.select().from(triggerRejectionCounters)).resolves.toMatchObject([
      { definitionId: "def_1", nodeId: "node_a", reason: "rate_limited", count: 1 },
    ]);

    // The next window starts clean, refusals in the old one notwithstanding.
    await expect(
      enforceTriggerRateLimit(db, keyA, limit, nextWindow),
    ).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it("admits exactly max starts when they all arrive at once", async () => {
    // The whole algorithm is one INSERT ... ON CONFLICT DO UPDATE ... RETURNING,
    // so each caller gets its own count from the row it just updated and no two
    // can read the same pre-increment value. PGlite serializes these, which is
    // what makes the assertion deterministic; on Postgres the row lock does it.
    const decisions = await Promise.all(
      Array.from({ length: 25 }, () =>
        enforceTriggerRateLimit(db, keyA, { max: 10, windowKind: "hour" }, inWindow),
      ),
    );

    expect(decisions.filter((decision) => decision?.allowed)).toHaveLength(10);
    expect(new Set(decisions.map((decision) => decision?.count)).size).toBe(25);
    const [row] = await db.select().from(triggerRateLimits);
    expect(row).toMatchObject({ count: 25 });
    const [rejections] = await db.select().from(triggerRejectionCounters);
    expect(rejections).toMatchObject({ count: 15 });
  });
});

describe("resolveTriggerRateLimitForType", () => {
  const envDefault = { max: 9, windowKind: "day" as const };

  it("keys the winning limit under the node that configured it", () => {
    expect(
      resolveTriggerRateLimitForType(
        [
          { nodeId: "t1", params: { rateLimitMax: 8, rateLimitWindow: "hour" } },
          { nodeId: "t2", params: { rateLimitMax: 3, rateLimitWindow: "hour" } },
        ],
        null,
      ),
    ).toEqual({ config: { max: 3, windowKind: "hour" }, nodeId: "t2" });
  });

  it("keys an env-only limit under the first node of the type", () => {
    expect(
      resolveTriggerRateLimitForType(
        [
          { nodeId: "t1", params: undefined },
          { nodeId: "t2", params: undefined },
        ],
        envDefault,
      ),
    ).toEqual({ config: envDefault, nodeId: "t1" });
  });

  it("is unlimited when nothing is configured", () => {
    expect(resolveTriggerRateLimitForType([{ nodeId: "t1", params: {} }], null)).toBeNull();
  });

  it("is unlimited when the graph has no node of this type to count under", () => {
    // The built-in fallback definition has no graph, so an env default would
    // otherwise have nowhere to key its counter.
    expect(resolveTriggerRateLimitForType([], envDefault)).toBeNull();
  });
});
