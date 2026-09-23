import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import {
  getLatestSystemHealthObservations,
  recordSystemHealthObservation,
  sweepSystemHealthObservations,
} from "../../db/repositories/system-health.js";
import {
  latestWebhookDeliveries,
  recordWebhookDelivery,
  systemHealthObservationScope,
} from "./observations.js";

// The connected half (`recordWebhookDelivery`, `latestWebhookDeliveries`) runs
// against the same test database the explicit-handle calls below use.
const connected = vi.hoisted(() => ({ db: undefined as unknown as Db }));
vi.mock("../../db/client.js", () => ({ getDb: () => connected.db }));

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  connected.db = db;
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("system health observations", () => {
  it("binds evidence to a one-way fingerprint of the configured secret", () => {
    const scope = systemHealthObservationScope("rotated-secret");
    expect(scope).toMatch(/^deployment:[a-f0-9]{64}$/);
    expect(scope).not.toContain("rotated-secret");
    expect(systemHealthObservationScope("other-secret")).not.toBe(scope);
  });

  it("only returns evidence for the requested configuration scope", async () => {
    await recordSystemHealthObservation(db, {
      integrationId: "scoped-provider",
      checkId: "webhook-delivery",
      scope: systemHealthObservationScope("old-secret"),
      outcome: "accepted",
      reason: "request_succeeded",
    });

    expect(
      await getLatestSystemHealthObservations(
        db,
        "scoped-provider",
        "webhook-delivery",
        systemHealthObservationScope("new-secret"),
      ),
    ).toEqual([]);
  });

  it("bounds writes by provider, outcome, reason, and UTC day", async () => {
    const first = new Date("2026-08-20T01:00:00.000Z");
    const second = new Date("2026-08-20T23:00:00.000Z");
    await recordSystemHealthObservation(db, {
      integrationId: "test-provider",
      checkId: "webhook-delivery",
      outcome: "accepted",
      reason: "signature_valid",
    }, first);
    await recordSystemHealthObservation(db, {
      integrationId: "test-provider",
      checkId: "webhook-delivery",
      outcome: "accepted",
      reason: "signature_valid",
    }, second);

    expect(
      await getLatestSystemHealthObservations(
        db,
        "test-provider",
        "webhook-delivery",
      ),
    ).toEqual([
      {
        outcome: "accepted",
        reason: "signature_valid",
        count: 2,
        observedAt: second,
      },
    ]);
  });

  it("sweeps observations older than the 30-day retention window", async () => {
    await recordSystemHealthObservation(db, {
      integrationId: "expired-provider",
      checkId: "webhook-delivery",
      outcome: "rejected",
      reason: "invalid_signature",
    }, new Date("2026-07-01T12:00:00.000Z"));

    await sweepSystemHealthObservations(db, new Date("2026-08-21T12:00:00.000Z"));

    expect(
      await getLatestSystemHealthObservations(
        db,
        "expired-provider",
        "webhook-delivery",
      ),
    ).toEqual([]);
  });
});

describe("integration webhook deliveries", () => {
  const production = "https://ai-workflow.example.com";
  const demo = "https://ai-workflow-demo.example.com";

  it("are read back by the deployment that received them", async () => {
    vi.stubEnv("BETTER_AUTH_URL", production);
    await recordWebhookDelivery({
      integrationId: "shared-db-own",
      outcome: "accepted",
      reason: "request_accepted",
    });

    expect(await latestWebhookDeliveries("shared-db-own")).toEqual([
      expect.objectContaining({ outcome: "accepted", reason: "request_accepted" }),
    ]);
  });

  it("are not read by another deployment that shares the database", async () => {
    // Demo shares production's database. A delivery demo accepted is no
    // evidence that production's webhook reaches production.
    vi.stubEnv("BETTER_AUTH_URL", demo);
    await recordWebhookDelivery({
      integrationId: "shared-db-other",
      outcome: "accepted",
      reason: "request_accepted",
    });

    vi.stubEnv("BETTER_AUTH_URL", production);
    expect(await latestWebhookDeliveries("shared-db-other")).toEqual([]);
  });

  it("belong to the same deployment whether or not its address ends in a slash", async () => {
    vi.stubEnv("BETTER_AUTH_URL", `${production}/`);
    await recordWebhookDelivery({
      integrationId: "shared-db-slash",
      outcome: "rejected",
      reason: "request_refused_401",
    });

    vi.stubEnv("BETTER_AUTH_URL", production);
    expect(await latestWebhookDeliveries("shared-db-slash")).toEqual([
      expect.objectContaining({ outcome: "rejected", reason: "request_refused_401" }),
    ]);
  });
});
