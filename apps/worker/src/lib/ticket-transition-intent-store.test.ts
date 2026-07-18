import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { activeRuns, ticketTransitionIntents } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  consumeTicketTransitionIntent,
  discardTicketTransitionIntent,
  recordTicketTransitionIntent,
} from "./ticket-transition-intent-store.js";

let db: Db;

const subjectKey = "ticket:jira:AIW-101";
const ticketKey = "AIW-101";

beforeEach(async () => {
  db = await createTestDb();
});

async function insertOwner(input: {
  ownerToken: string;
  runId: string | null;
  state: "reserved" | "bound";
}): Promise<void> {
  await db.insert(activeRuns).values({
    subjectKey,
    ticketKey,
    ownerToken: input.ownerToken,
    runId: input.runId,
    state: input.state,
    runKind: "ticket",
  });
}

function intentOwner(ownerToken: string, runId: string | null) {
  return {
    ticketKey,
    subjectKey,
    ownerToken,
    runId,
    actorAccountId: "jira-bot-account",
  };
}

function echo(webhookIdentifier = "jira-delivery-1", actorAccountId = "jira-bot-account") {
  return { webhookIdentifier, actorAccountId };
}

describe("ticket transition intents", () => {
  it("records intent for the exact reserved owner with a null run id", async () => {
    await insertOwner({ ownerToken: "owner-reserved", runId: null, state: "reserved" });

    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-reserved", null),
      target: { name: "AI", statusId: "10010" },
    });

    expect(await db.select().from(ticketTransitionIntents)).toEqual([
      expect.objectContaining({
        subjectKey,
        ownerToken: "owner-reserved",
        runId: null,
        actorAccountId: "jira-bot-account",
        targetStatusId: "10010",
      }),
    ]);
  });

  it("retains workflow echoes for at least Jira's full retry window", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const before = Date.now();

    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "Done",
    });

    const [intent] = await db.select().from(ticketTransitionIntents);
    expect(intent.expiresAt.getTime() - before).toBeGreaterThanOrEqual(75 * 60 * 1000);
  });

  it("records intent for the exact bound owner and run", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });

    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "Backlog",
    });

    expect(await db.select().from(ticketTransitionIntents)).toEqual([
      expect.objectContaining({ ownerToken: "owner-bound", runId: "run-1" }),
    ]);
  });

  it("rejects the wrong owner, wrong run, and reserved owner paired with a run id", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });

    await expect(
      recordTicketTransitionIntent(db, {
        ...intentOwner("owner-other", "run-1"),
        target: "Backlog",
      }),
    ).rejects.toThrow(/exact current owner/);
    await expect(
      recordTicketTransitionIntent(db, {
        ...intentOwner("owner-bound", "run-other"),
        target: "Backlog",
      }),
    ).rejects.toThrow(/exact current owner/);

    await db.delete(activeRuns).where(eq(activeRuns.subjectKey, subjectKey));
    await insertOwner({ ownerToken: "owner-reserved", runId: null, state: "reserved" });
    await expect(
      recordTicketTransitionIntent(db, {
        ...intentOwner("owner-reserved", "run-not-bound"),
        target: "AI",
      }),
    ).rejects.toThrow(/exact current owner/);
  });

  it("consumes a matching intent after its owner row is released", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });
    await db.delete(activeRuns).where(eq(activeRuns.subjectKey, subjectKey));

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
  });

  it("survives reservation handoff after recording", async () => {
    await insertOwner({ ownerToken: "owner-first", runId: null, state: "reserved" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-first", null),
      target: { name: "AI", statusId: "10010" },
    });
    await db
      .update(activeRuns)
      .set({ ownerToken: "owner-successor" })
      .where(eq(activeRuns.subjectKey, subjectKey));

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10010", name: "AI" }, echo()),
    ).resolves.toBe(true);
  });

  it("suppresses concurrent retries of the same webhook idempotently", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });

    const results = await Promise.all([
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ]);

    expect(results).toEqual([true, true]);
  });

  it("lets only one of two concurrent delivery identities consume the intent", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });

    const results = await Promise.all([
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10042", name: "Done" },
        echo("jira-delivery-1"),
      ),
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10042", name: "Done" },
        echo("jira-delivery-2"),
      ),
    ]);

    expect(results.sort()).toEqual([false, true]);
  });

  it("suppresses a later retry after its intent was consumed", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
  });

  it("requires the exact workflow actor before consuming an intent", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });

    await expect(
      consumeTicketTransitionIntent(
        db,
        ticketKey,
        { id: "10042", name: "Done" },
        echo("jira-human-delivery", "human-account"),
      ),
    ).resolves.toBe(false);
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
  });

  it("consumes the oldest matching unconsumed intent first", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const olderId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "AI Review",
    });
    const newerId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "AI Review",
    });
    await db
      .update(ticketTransitionIntents)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(ticketTransitionIntents.id, olderId));
    await db
      .update(ticketTransitionIntents)
      .set({ createdAt: new Date("2026-01-02T00:00:00Z") })
      .where(eq(ticketTransitionIntents.id, newerId));

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { name: "ai review" }, echo()),
    ).resolves.toBe(true);

    const rows = await db
      .select()
      .from(ticketTransitionIntents)
      .orderBy(ticketTransitionIntents.id);
    expect(rows.find(({ id }) => id === olderId)?.consumedAt).toBeInstanceOf(Date);
    expect(rows.find(({ id }) => id === newerId)?.consumedAt).toBeNull();
  });

  it("discards only the intent with the exact id", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    const discardedId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "AI Review",
    });
    const retainedId = await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: "AI Review",
    });

    await expect(discardTicketTransitionIntent(db, discardedId)).resolves.toBe(true);
    await expect(discardTicketTransitionIntent(db, discardedId)).resolves.toBe(false);
    expect(await db.select().from(ticketTransitionIntents)).toEqual([
      expect.objectContaining({ id: retainedId }),
    ]);
  });

  it("matches a legacy configured destination by status name", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "AI Review", transitionId: "31" },
    });

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10010", name: "AI Review" }, echo()),
    ).resolves.toBe(true);
  });

  it("requires matching provider ids when both intent and webhook have one", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });

    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "99999", name: "Done" }, echo()),
    ).resolves.toBe(false);
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Renamed Done" }, echo()),
    ).resolves.toBe(true);
  });

  it("does not consume mismatched or expired intents and replays the same delivery", async () => {
    await insertOwner({ ownerToken: "owner-bound", runId: "run-1", state: "bound" });
    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
      ttlMs: -1,
    });
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(false);

    await recordTicketTransitionIntent(db, {
      ...intentOwner("owner-bound", "run-1"),
      target: { name: "Done", statusId: "10042" },
    });
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "99999", name: "Backlog" }, echo()),
    ).resolves.toBe(false);
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
    await expect(
      consumeTicketTransitionIntent(db, ticketKey, { id: "10042", name: "Done" }, echo()),
    ).resolves.toBe(true);
  });
});
