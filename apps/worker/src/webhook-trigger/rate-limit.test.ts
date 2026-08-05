import { beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  webhookTriggerEndpoints,
  webhookTriggerRateLimits,
  workflowDefinitions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
  WEBHOOK_INGRESS_LIMIT_PER_MINUTE,
  checkAndIncrementWebhookRate,
  sweepWebhookRateLimits,
  webhookRateWindowStart,
} from "./rate-limit.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(workflowDefinitions).values({
    id: 9,
    name: "Webhook flow",
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(webhookTriggerEndpoints).values(
    ["wh_a", "wh_b"].map((id) => ({
      id,
      definitionId: 9,
      nodeId: id,
      secretCiphertext: "v1:00000000:iv:tag:data",
    })),
  );
});

const inWindow = new Date("2026-02-01T10:00:31.500Z");
const nextWindow = new Date("2026-02-01T10:01:00.000Z");

describe("webhook rate limiting", () => {
  it("floors the window to the minute", () => {
    expect(webhookRateWindowStart(inWindow)).toEqual(
      new Date("2026-02-01T10:00:00.000Z"),
    );
  });

  it("counts every request in a window and refuses past the limit", async () => {
    const decisions = [];
    for (let request = 0; request < 4; request += 1) {
      decisions.push(await checkAndIncrementWebhookRate(db, "wh_a", "inbox", 2, inWindow));
    }

    expect(decisions.map((decision) => [decision.count, decision.allowed])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ]);
    expect(decisions[0]).toMatchObject({
      limit: 2,
      windowStart: new Date("2026-02-01T10:00:00.000Z"),
    });
  });

  it("starts a fresh count in the next minute and never shares one across endpoints", async () => {
    await checkAndIncrementWebhookRate(db, "wh_a", "inbox", 1, inWindow);
    await expect(
      checkAndIncrementWebhookRate(db, "wh_a", "inbox", 1, inWindow),
    ).resolves.toMatchObject({ count: 2, allowed: false });

    await expect(
      checkAndIncrementWebhookRate(db, "wh_a", "inbox", 1, nextWindow),
    ).resolves.toMatchObject({ count: 1, allowed: true });
    await expect(
      checkAndIncrementWebhookRate(db, "wh_b", "inbox", 1, inWindow),
    ).resolves.toMatchObject({ count: 1, allowed: true });
  });

  it("keeps the ingress and inbox budgets independent within one window", async () => {
    await checkAndIncrementWebhookRate(db, "wh_a", "ingress", 1, inWindow);
    await expect(
      checkAndIncrementWebhookRate(db, "wh_a", "ingress", 1, inWindow),
    ).resolves.toMatchObject({ count: 2, allowed: false });

    // The inbox budget starts fresh: spending ingress does not touch it.
    await expect(
      checkAndIncrementWebhookRate(db, "wh_a", "inbox", 1, inWindow),
    ).resolves.toMatchObject({ count: 1, allowed: true });
  });

  it("documents both per-minute limits", () => {
    expect(DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE).toBe(60);
    expect(WEBHOOK_INGRESS_LIMIT_PER_MINUTE).toBe(600);
    expect(WEBHOOK_INGRESS_LIMIT_PER_MINUTE).toBeGreaterThan(
      DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
    );
  });

  it("sweeps windows older than an hour and keeps the live ones", async () => {
    await checkAndIncrementWebhookRate(db, "wh_a", "inbox", 60, new Date("2026-02-01T08:00:00.000Z"));
    await checkAndIncrementWebhookRate(db, "wh_a", "inbox", 60, new Date("2026-02-01T09:30:00.000Z"));
    await checkAndIncrementWebhookRate(db, "wh_a", "inbox", 60, inWindow);

    await sweepWebhookRateLimits(db, inWindow);

    await expect(
      db
        .select()
        .from(webhookTriggerRateLimits)
        .orderBy(asc(webhookTriggerRateLimits.windowStart)),
    ).resolves.toMatchObject([
      { windowStart: new Date("2026-02-01T09:30:00.000Z") },
      { windowStart: new Date("2026-02-01T10:00:00.000Z") },
    ]);
  });
});
