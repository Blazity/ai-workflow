import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { activeRuns, clarificationRequests } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  answerHookClarification,
  getHookClarification,
  getResumableClarificationForTicket,
  prepareHookClarification,
  publishHookClarification,
  recordHookClarificationSnapshot,
} from "./hook-store.js";

const input = {
  ticketKey: "AWT-1",
  subjectKey: "ticket:jira:AWT-1",
  runId: "run-1",
  blockId: "question",
  definitionId: 4,
  definitionVersion: 7,
  questions: ["Which repository?"],
};

async function bindRun(
  db: Db,
  opts: { subjectKey?: string; ticketKey?: string; runId?: string } = {},
): Promise<void> {
  await db.insert(activeRuns).values({
    subjectKey: opts.subjectKey ?? input.subjectKey,
    ticketKey: opts.ticketKey ?? input.ticketKey,
    ownerToken: "owner-bound",
    runId: opts.runId ?? input.runId,
    state: "bound",
    runKind: "ticket",
  });
}

async function publishPending(db: Db, askedAt?: Date) {
  const prepared = await prepareHookClarification(db, input);
  const published = await publishHookClarification(db, prepared.id);
  if (askedAt) {
    await db
      .update(clarificationRequests)
      .set({ askedAt })
      .where(eq(clarificationRequests.id, prepared.id));
  }
  return published;
}

describe("clarification hook store", () => {
  it("publishes only after the hook row and optional snapshot are durable", async () => {
    const db = await createTestDb();
    const prepared = await prepareHookClarification(db, input);
    expect(prepared.status).toBe("preparing");
    expect(prepared.hookToken).toBe(`clarification:${prepared.id}`);

    await recordHookClarificationSnapshot(db, prepared.id, {
      snapshotId: "snapshot-1",
      sourceSandboxId: "sandbox-1",
      expiresAt: new Date("2026-07-27T00:00:00.000Z"),
    });
    const published = await publishHookClarification(db, prepared.id);

    expect(published).toMatchObject({
      status: "pending",
      snapshotId: "snapshot-1",
      cleanupState: "retained",
    });
  });

  it("maps expiresAt as a Date about seven days out", async () => {
    const db = await createTestDb();
    const before = Date.now();
    const prepared = await prepareHookClarification(db, input);
    expect(prepared.expiresAt).toBeInstanceOf(Date);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;
    const delta = (prepared.expiresAt as Date).getTime() - before;
    // Allow slack for DB round-trip; expiry is roughly +7 days from creation.
    expect(delta).toBeGreaterThan(sevenDaysMs - 60_000);
    expect(delta).toBeLessThan(sevenDaysMs + 60_000);

    // The mapped value survives a fetch of the same row.
    const fetched = await getHookClarification(db, prepared.id);
    expect(fetched?.expiresAt).toBeInstanceOf(Date);
    expect(fetched?.expiresAt?.getTime()).toBe((prepared.expiresAt as Date).getTime());
  });

  it("allows exactly one answer CAS", async () => {
    const db = await createTestDb();
    const prepared = await prepareHookClarification(db, input);
    await publishHookClarification(db, prepared.id);

    const [first, second] = await Promise.all([
      answerHookClarification(db, prepared.id, "API", { id: "u1", label: "One" }),
      answerHookClarification(db, prepared.id, "Dashboard", { id: "u2", label: "Two" }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await getHookClarification(db, prepared.id))?.status).toBe("answered");
  });
});

describe("getResumableClarificationForTicket", () => {
  it("returns the pending row while its run holds the bound subject claim", async () => {
    const db = await createTestDb();
    const published = await publishPending(db);
    await bindRun(db);

    const found = await getResumableClarificationForTicket(db, "AWT-1");
    expect(found?.id).toBe(published.id);
    expect(found?.status).toBe("pending");
  });

  it("returns null when no run is bound for the subject", async () => {
    const db = await createTestDb();
    await publishPending(db);

    expect(await getResumableClarificationForTicket(db, "AWT-1")).toBeNull();
  });

  it("returns null once the claim is no longer bound", async () => {
    const db = await createTestDb();
    await publishPending(db);
    await bindRun(db);
    await db
      .update(activeRuns)
      .set({ state: "cancelling" })
      .where(eq(activeRuns.subjectKey, input.subjectKey));

    expect(await getResumableClarificationForTicket(db, "AWT-1")).toBeNull();
  });

  it("returns null for a superseded row even with a bound claim", async () => {
    const db = await createTestDb();
    const published = await publishPending(db);
    await bindRun(db);
    await db
      .update(clarificationRequests)
      .set({ status: "superseded" })
      .where(eq(clarificationRequests.id, published.id));

    expect(await getResumableClarificationForTicket(db, "AWT-1")).toBeNull();
  });

  it("returns an answered row so a lost resume can be retried", async () => {
    const db = await createTestDb();
    const published = await publishPending(db);
    await answerHookClarification(db, published.id, "Use main", {
      id: "user_1",
      label: "Ada",
    });
    await bindRun(db);

    const found = await getResumableClarificationForTicket(db, "AWT-1");
    expect(found?.id).toBe(published.id);
    expect(found?.status).toBe("answered");
  });

  it("picks the newest round by asked_at", async () => {
    const db = await createTestDb();
    const older = await publishPending(db, new Date("2026-07-20T10:00:00.000Z"));
    await answerHookClarification(db, older.id, "first round", {
      id: "user_1",
      label: "Ada",
    });
    const newer = await publishPending(db, new Date("2026-07-20T12:00:00.000Z"));
    await bindRun(db);

    const found = await getResumableClarificationForTicket(db, "AWT-1");
    expect(found?.id).toBe(newer.id);
  });
});
