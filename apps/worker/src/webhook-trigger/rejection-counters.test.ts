import { beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { webhookTriggerRejectionCounters } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  getWebhookRejectionsToday,
  recordWebhookRejection,
  sweepWebhookRejectionCounters,
  webhookRejectionWindowStart,
} from "./rejection-counters.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

const today = new Date("2026-03-10T13:45:00.000Z");
const yesterday = new Date("2026-03-09T23:59:59.000Z");

describe("webhook rejection counters", () => {
  it("floors the window to the day", () => {
    expect(webhookRejectionWindowStart(today)).toEqual(
      new Date("2026-03-10T00:00:00.000Z"),
    );
  });

  it("tallies each reason per endpoint and day", async () => {
    await recordWebhookRejection(db, "wh_a", "invalid_signature", today);
    await recordWebhookRejection(db, "wh_a", "invalid_signature", today);
    await recordWebhookRejection(db, "wh_a", "rate_limited", today);
    await recordWebhookRejection(db, "wh_a", "invalid_signature", yesterday);
    await recordWebhookRejection(db, "wh_b", "invalid_signature", today);

    await expect(getWebhookRejectionsToday(db, "wh_a", today)).resolves.toEqual([
      { reason: "invalid_signature", count: 2 },
      { reason: "rate_limited", count: 1 },
    ]);
    await expect(getWebhookRejectionsToday(db, "wh_b", today)).resolves.toEqual([
      { reason: "invalid_signature", count: 1 },
    ]);
    await expect(getWebhookRejectionsToday(db, "wh_never_existed", today)).resolves.toEqual(
      [],
    );
  });

  it("counts a request to an endpoint id that never existed", async () => {
    await recordWebhookRejection(db, "wh_guessed", "unknown_endpoint", today);

    await expect(getWebhookRejectionsToday(db, "wh_guessed", today)).resolves.toEqual([
      { reason: "unknown_endpoint", count: 1 },
    ]);
  });

  it("sweeps windows older than thirty days and keeps the rest", async () => {
    await recordWebhookRejection(db, "wh_a", "old", new Date("2026-02-01T00:00:00.000Z"));
    await recordWebhookRejection(db, "wh_a", "recent", new Date("2026-02-20T00:00:00.000Z"));
    await recordWebhookRejection(db, "wh_a", "today", today);

    await sweepWebhookRejectionCounters(db, today);

    await expect(
      db
        .select({ reason: webhookTriggerRejectionCounters.reason })
        .from(webhookTriggerRejectionCounters)
        .orderBy(asc(webhookTriggerRejectionCounters.windowStart)),
    ).resolves.toEqual([{ reason: "recent" }, { reason: "today" }]);
  });
});
