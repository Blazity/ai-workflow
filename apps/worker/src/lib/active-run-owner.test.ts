import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { activeRuns } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { ActiveRunOwnerError, assertActiveRunOwner } from "./active-run-owner.js";

let db: Db;
const subjectKey = "ticket:jira:AIW-101";

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(activeRuns).values({
    subjectKey,
    ticketKey: "AIW-101",
    ownerToken: "owner-bound",
    runId: "run-1",
    state: "bound",
    runKind: "ticket",
  });
});

describe("assertActiveRunOwner", () => {
  it("requires the exact owner and run to remain bound at the provider boundary", async () => {
    await expect(
      assertActiveRunOwner(db, {
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
      }),
    ).resolves.toBeUndefined();

    await db
      .update(activeRuns)
      .set({ state: "cancelling" })
      .where(eq(activeRuns.subjectKey, subjectKey));
    await expect(
      assertActiveRunOwner(db, {
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
      }),
    ).rejects.toBeInstanceOf(ActiveRunOwnerError);

    await db
      .update(activeRuns)
      .set({
        state: "bound",
        ownerToken: "owner-successor",
      })
      .where(eq(activeRuns.subjectKey, subjectKey));
    await expect(
      assertActiveRunOwner(db, {
        subjectKey,
        ownerToken: "owner-bound",
        runId: "run-1",
      }),
    ).rejects.toThrow(/exact active run owner/i);
  });

  it("accepts only the exact pre-start reservation when the run id is null", async () => {
    await db.delete(activeRuns).where(eq(activeRuns.subjectKey, subjectKey));
    await db.insert(activeRuns).values({
      subjectKey,
      ticketKey: "AIW-101",
      ownerToken: "owner-reserved",
      runId: null,
      state: "reserved",
      runKind: "ticket",
    });

    await expect(
      assertActiveRunOwner(db, {
        subjectKey,
        ownerToken: "owner-reserved",
        runId: null,
      }),
    ).resolves.toBeUndefined();

    await db
      .update(activeRuns)
      .set({ state: "cancelling" })
      .where(eq(activeRuns.subjectKey, subjectKey));
    await expect(
      assertActiveRunOwner(db, {
        subjectKey,
        ownerToken: "owner-reserved",
        runId: null,
      }),
    ).rejects.toThrow(/exact active run owner/i);
  });
});
