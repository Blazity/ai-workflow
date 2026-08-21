import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import {
  getLatestSystemHealthObservations,
  recordSystemHealthObservation,
  sweepSystemHealthObservations,
  systemHealthObservationScope,
} from "./observations.js";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

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
