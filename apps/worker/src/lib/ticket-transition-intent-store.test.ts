import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { activeRuns, ticketTransitionIntents } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  consumeTicketTransitionIntent,
  discardTicketTransitionIntent,
  recordTicketTransitionIntent,
} from "./ticket-transition-intent-store.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(activeRuns).values({
    subjectKey: "ticket:jira:AIW-101",
    ticketKey: "AIW-101",
    ownerToken: "owner-1",
    runId: "run-1",
    state: "bound",
    runKind: "pr_trigger",
  });
});

const owner = {
  ticketKey: "AIW-101",
  subjectKey: "ticket:jira:AIW-101",
  ownerToken: "owner-1",
  runId: "run-1",
};

describe("ticket transition intents", () => {
  it("consumes a matching provider status id and tolerates duplicate webhook delivery", async () => {
    await recordTicketTransitionIntent(db, {
      ...owner,
      target: { name: "10042", statusId: "10042" },
    });

    await expect(
      consumeTicketTransitionIntent(db, "AIW-101", { id: "10042", name: "Done" }),
    ).resolves.toBe(true);
    await expect(
      consumeTicketTransitionIntent(db, "AIW-101", { id: "10042", name: "Done" }),
    ).resolves.toBe(true);

    const rows = await db.select().from(ticketTransitionIntents);
    expect(rows[0]?.consumedAt).toBeInstanceOf(Date);
  });

  it("matches legacy configured destinations by status name", async () => {
    await recordTicketTransitionIntent(db, {
      ...owner,
      target: { name: "AI Review", transitionId: "31" },
    });

    await expect(
      consumeTicketTransitionIntent(db, "AIW-101", { id: "10010", name: "AI Review" }),
    ).resolves.toBe(true);
  });

  it("does not consume mismatched, expired, or no-longer-owned intents", async () => {
    await recordTicketTransitionIntent(db, {
      ...owner,
      target: { name: "10042", statusId: "10042" },
      ttlMs: -1,
    });
    await expect(
      consumeTicketTransitionIntent(db, "AIW-101", { id: "10042", name: "Done" }),
    ).resolves.toBe(false);

    await recordTicketTransitionIntent(db, {
      ...owner,
      target: { name: "10042", statusId: "10042" },
    });
    await db.delete(activeRuns).where(eq(activeRuns.subjectKey, owner.subjectKey));
    await expect(
      consumeTicketTransitionIntent(db, "AIW-101", { id: "10042", name: "Done" }),
    ).resolves.toBe(false);
  });

  it("can discard an intent when the provider transition fails", async () => {
    const id = await recordTicketTransitionIntent(db, {
      ...owner,
      target: { name: "10042", statusId: "10042" },
    });
    await discardTicketTransitionIntent(db, id);
    expect(await db.select().from(ticketTransitionIntents)).toEqual([]);
  });
});
