import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import { dispatchCapacityQueue } from "../db/schema.js";
import {
  claimForComment,
  ensureQueued,
  listQueued,
  reconcileAtCapacityQueue,
  reconcileQueue,
} from "./at-capacity-queue.js";

let db: Db;

function fakeTracker() {
  return { postComment: vi.fn(async () => null) };
}

const T = "AIW-1";

// Applying 50 migrations into a fresh PGlite per test is slow; build the schema
// once and clear the one table under test between cases instead.
beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.delete(dispatchCapacityQueue);
});

async function tick(
  tracker: { postComment: ReturnType<typeof vi.fn> },
  opts: {
    atCapacityKeys?: string[];
    startedKeys?: string[];
    currentTicketKeys?: string[];
    claimLeaseMs?: number;
  } = {},
) {
  return reconcileAtCapacityQueue({
    db,
    issueTracker: tracker,
    atCapacityKeys: opts.atCapacityKeys ?? [T],
    startedKeys: opts.startedKeys ?? [],
    currentTicketKeys: opts.currentTicketKeys ?? [T],
    claimLeaseMs: opts.claimLeaseMs,
  });
}

describe("reconcileAtCapacityQueue", () => {
  // (i) idempotency across many ticks.
  it("posts exactly ONE comment for the same at-capacity ticket across 14 ticks", async () => {
    const tracker = fakeTracker();
    for (let i = 0; i < 14; i++) await tick(tracker);
    expect(tracker.postComment).toHaveBeenCalledTimes(1);
    expect(tracker.postComment).toHaveBeenCalledWith(
      T,
      expect.stringContaining("waiting for a free workflow execution slot"),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  // (ii) a failed Jira call must NOT permanently suppress — it retries.
  it("retries when the Jira comment call throws until it lands", async () => {
    const tracker = fakeTracker();
    tracker.postComment.mockRejectedValueOnce(new Error("jira down"));

    // Lease 0 so the retry on the next tick is not blocked by the fresh attempt.
    await tick(tracker, { claimLeaseMs: 0 });
    expect(tracker.postComment).toHaveBeenCalledTimes(1);
    // confirmed_at stayed NULL — the row is still unconfirmed.
    expect((await listQueued(db)).map((q) => q.ticketKey)).toEqual([T]);

    await tick(tracker, { claimLeaseMs: 0 });
    expect(tracker.postComment).toHaveBeenCalledTimes(2);

    // Now confirmed: further ticks send nothing.
    await tick(tracker, { claimLeaseMs: 0 });
    expect(tracker.postComment).toHaveBeenCalledTimes(2);
  });

  // (iii) non-at_capacity reasons never enter the queue: zero comments, zero rows.
  it("does not comment or queue when a ticket is refused for a non-at_capacity reason", async () => {
    const tracker = fakeTracker();
    // Ticket sits in the column but was refused (e.g. already_claimed /
    // not_in_ai_column), so it never appears in atCapacityKeys.
    await tick(tracker, { atCapacityKeys: [], currentTicketKeys: [T] });
    expect(tracker.postComment).not.toHaveBeenCalled();
    expect(await listQueued(db)).toEqual([]);
  });

  // (iv) leaving then re-entering the column = a new episode = a second comment.
  it("posts a second comment after the ticket leaves the AI column and returns", async () => {
    const tracker = fakeTracker();
    await tick(tracker); // episode 1: comment
    expect(tracker.postComment).toHaveBeenCalledTimes(1);

    // Ticket leaves the column. The listing is NON-EMPTY (another ticket is
    // present), so reconcile can safely delete the departed ticket's row.
    await tick(tracker, { atCapacityKeys: [], currentTicketKeys: ["AIW-OTHER"] });
    expect((await listQueued(db)).map((q) => q.ticketKey)).toEqual([]);

    // Ticket returns, still at capacity — fresh episode, second comment.
    await tick(tracker);
    expect(tracker.postComment).toHaveBeenCalledTimes(2);
  });

  // (v) a normally-dispatching ticket leaves no trace.
  it("leaves no row and posts no comment for a ticket that dispatches normally", async () => {
    const tracker = fakeTracker();
    await tick(tracker, {
      atCapacityKeys: [],
      currentTicketKeys: ["AIW-2"],
    });
    expect(tracker.postComment).not.toHaveBeenCalled();
    expect(await listQueued(db)).toEqual([]);
  });

  // BLOCKER 2: a ticket that dispatches on a later tick has its row deleted and
  // stops appearing in the waiting list (it is running, not waiting).
  it("deletes the row when a previously-refused ticket dispatches", async () => {
    const tracker = fakeTracker();
    await tick(tracker); // refused at_capacity → queued + commented
    expect((await listQueued(db)).map((q) => q.ticketKey)).toEqual([T]);

    // Next tick it dispatches (still in the column while it runs).
    await tick(tracker, {
      atCapacityKeys: [],
      startedKeys: [T],
      currentTicketKeys: [T],
    });
    expect(await listQueued(db)).toEqual([]);
  });

  // BLOCKER 1(b): an empty (or failed) listing is UNKNOWN, not empty — the whole
  // queue must NOT be wiped, or the next tick re-comments everything.
  it("skips reconcile-delete when the AI-column listing is empty", async () => {
    const tracker = fakeTracker();
    await tick(tracker); // queue + confirm T
    expect((await listQueued(db)).map((q) => q.ticketKey)).toEqual([T]);

    // A transient empty listing must not delete T's row.
    await tick(tracker, { atCapacityKeys: [], currentTicketKeys: [] });
    expect((await listQueued(db)).map((q) => q.ticketKey)).toEqual([T]);
    // And no fresh comment was produced.
    expect(tracker.postComment).toHaveBeenCalledTimes(1);
  });

  // Bound caps confirmed comments per tick but never row creation.
  it("caps confirmed comments per tick at the bound while queuing every refused ticket", async () => {
    const tracker = fakeTracker();
    const keys = ["AIW-1", "AIW-2", "AIW-3", "AIW-4"];
    const result = await reconcileAtCapacityQueue({
      db,
      issueTracker: tracker,
      atCapacityKeys: keys,
      startedKeys: [],
      currentTicketKeys: keys,
      bound: 2,
    });
    expect(result.queued).toBe(4);
    expect(tracker.postComment).toHaveBeenCalledTimes(2);
    // All four are queued (suppressing rows), even though only two were commented.
    expect((await listQueued(db)).length).toBe(4);
  });
});

describe("claimForComment lease", () => {
  it("lets only one of two overlapping claims win", async () => {
    await ensureQueued(db, T);
    const first = await claimForComment(db, T, 120_000);
    const second = await claimForComment(db, T, 120_000);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe("reconcileQueue", () => {
  it("deletes rows for tickets absent from the current column and keeps the rest", async () => {
    await ensureQueued(db, "AIW-1");
    await ensureQueued(db, "AIW-2");
    const deleted = await reconcileQueue(db, ["AIW-2"]);
    expect(deleted).toBe(1);
    expect((await listQueued(db)).map((q) => q.ticketKey)).toEqual(["AIW-2"]);
  });

  it("deletes nothing on an empty listing (treated as UNKNOWN, not empty)", async () => {
    await ensureQueued(db, "AIW-1");
    await ensureQueued(db, "AIW-2");
    expect(await reconcileQueue(db, [])).toBe(0);
    expect((await listQueued(db)).map((q) => q.ticketKey)).toEqual([
      "AIW-1",
      "AIW-2",
    ]);
  });
});
