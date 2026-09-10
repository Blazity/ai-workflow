import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  triggerDeliveries,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { isUniqueViolation } from "./unique-violation.js";

/** Minimal valid row for the trigger_deliveries table, only varying the
 *  delivery id, so two inserts collide on subject_key while pending. */
function pendingDeliveryRow(deliveryId: string, definitionId: number) {
  return {
    provider: "github" as const,
    deliveryId,
    producer: "github-actions",
    triggerType: "trigger_pr_checks_failed",
    subjectKey: "pr:github:acme/api#1",
    headSha: "sha",
    definitionId,
    definitionVersion: 1,
    payload: {},
    pending: true,
  };
}

describe("isUniqueViolation", () => {
  it("recognizes a real unique-constraint violation raised through drizzle", async () => {
    // Same partial unique index (trigger_deliveries_one_pending_per_subject_idx)
    // that coalescePendingTrigger's retry loop guards against, hit directly so
    // the error comes from the real driver, not a hand-built object. Drizzle
    // wraps that driver error in its own DrizzleQueryError and hangs the
    // original off `cause`, so SQLSTATE 23505 is one level down, not on top.
    const db: Db = await createTestDb();
    const [definition] = await db
      .insert(workflowDefinitions)
      .values({
        name: "Unique violation probe",
        createdById: "test",
        createdByLabel: "Test",
      })
      .returning();
    await db.insert(workflowDefinitionVersions).values({
      definitionId: definition!.id,
      version: 1,
      definition: {},
      createdById: "test",
      createdByLabel: "Test",
    });

    await db
      .insert(triggerDeliveries)
      .values(pendingDeliveryRow("d-1", definition!.id));
    const error: unknown = await db
      .insert(triggerDeliveries)
      .values(pendingDeliveryRow("d-2", definition!.id))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(isUniqueViolation(error)).toBe(true);
  });

  it("does not misclassify an unrelated error or a non-error value", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it("stops walking the cause chain past the depth cap", () => {
    let error: { message: string; cause?: unknown } = { message: "root", cause: { code: "23505" } };
    for (let i = 0; i < 6; i += 1) {
      error = { message: `wrap-${i}`, cause: error };
    }
    expect(isUniqueViolation(error)).toBe(false);
  });
});
