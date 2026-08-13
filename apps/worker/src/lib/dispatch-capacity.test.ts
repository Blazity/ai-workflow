import { describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import {
  commentOnQueuedTickets,
  formatQueuedComment,
  listQueuedDispatches,
  syncCapacityNotices,
} from "./dispatch-capacity.js";

const refusal = (ticketKey: string) => ({
  subjectKey: `ticket:jira:${ticketKey}`,
  ticketKey,
});

const tracker = () => ({
  postComment: vi.fn(async (): Promise<string | null> => null),
});

const pool = { limit: 3, occupied: 3 };

const notify = (db: Db, issueTracker: ReturnType<typeof tracker>) =>
  commentOnQueuedTickets(db, issueTracker, pool);

/** Occupants default to none, so a test only names them when they are the point. */
const sync = (
  db: Db,
  input: {
    refused: ReturnType<typeof refusal>[];
    liveTicketKeys: string[];
    occupied?: string[];
  },
) =>
  syncCapacityNotices(db, {
    refused: input.refused,
    liveTicketKeys: input.liveTicketKeys,
    occupiedSubjectKeys: new Set(input.occupied ?? []),
  });

describe("capacity queue ledger", () => {
  it("records a refused ticket as queued", async () => {
    const db = await createTestDb();

    await sync(db, {
      refused: [refusal("UP-1")],
      liveTicketKeys: ["UP-1"],
    });

    const queued = await listQueuedDispatches(db);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ ticketKey: "UP-1", notifiedAt: null });
  });

  // Observed on production 2026-08-13: with the pool full, the capacity gate runs
  // before the claim attempt, so a ticket whose run was already in flight came back
  // refused as at_capacity and was told it was queued 45 seconds after starting.
  it("never queues a ticket whose own run holds a slot", async () => {
    const db = await createTestDb();
    const issueTracker = tracker();

    await sync(db, {
      refused: [refusal("UP-1"), refusal("UP-2")],
      liveTicketKeys: ["UP-1", "UP-2"],
      occupied: ["ticket:jira:UP-1"],
    });

    const queued = await listQueuedDispatches(db);
    expect(queued.map((row) => row.ticketKey)).toEqual(["UP-2"]);
    await notify(db, issueTracker);
    expect(issueTracker.postComment).toHaveBeenCalledTimes(1);
    expect(issueTracker.postComment).toHaveBeenCalledWith(
      "UP-2",
      expect.any(String),
    );
  });

  // The wait has to keep its start time: it is what the dashboard shows and what
  // decides whether the ticket has already been told.
  it("keeps the original wait when the same ticket is refused again", async () => {
    const db = await createTestDb();
    await sync(db, {
      refused: [refusal("UP-1")],
      liveTicketKeys: ["UP-1"],
    });
    const first = (await listQueuedDispatches(db))[0].queuedSince;

    await sync(db, {
      refused: [refusal("UP-1")],
      liveTicketKeys: ["UP-1"],
    });

    const queued = await listQueuedDispatches(db);
    expect(queued).toHaveLength(1);
    expect(queued[0].queuedSince.getTime()).toBe(first.getTime());
  });

  it("drops the row once the ticket is no longer waiting", async () => {
    const db = await createTestDb();
    await sync(db, {
      refused: [refusal("UP-1"), refusal("UP-2")],
      liveTicketKeys: ["UP-1", "UP-2"],
    });

    // UP-1 started on this tick, so it is not among the tickets still waiting.
    await sync(db, { refused: [], liveTicketKeys: ["UP-2"] });

    expect((await listQueuedDispatches(db)).map((row) => row.ticketKey)).toEqual([
      "UP-2",
    ]);
  });

  it("empties the queue when nothing is left in the column", async () => {
    const db = await createTestDb();
    await sync(db, {
      refused: [refusal("UP-1")],
      liveTicketKeys: ["UP-1"],
    });

    await sync(db, { refused: [], liveTicketKeys: [] });

    expect(await listQueuedDispatches(db)).toEqual([]);
  });

  it("tells the ticket once and never again", async () => {
    const db = await createTestDb();
    await sync(db, {
      refused: [refusal("UP-1")],
      liveTicketKeys: ["UP-1"],
    });
    const issueTracker = tracker();

    expect(await notify(db, issueTracker)).toBe(1);
    expect(issueTracker.postComment).toHaveBeenCalledWith(
      "UP-1",
      expect.stringContaining("All workflow execution slots are currently in use"),
    );

    // Two more passes with the ticket still queued.
    await sync(db, {
      refused: [refusal("UP-1")],
      liveTicketKeys: ["UP-1"],
    });
    expect(await notify(db, issueTracker)).toBe(0);
    expect(issueTracker.postComment).toHaveBeenCalledTimes(1);
  });

  // A ticket somebody pulls out and puts back is a new wait, and a person who
  // moved it back deserves to be told again.
  it("tells the ticket again after it left the queue and came back", async () => {
    const db = await createTestDb();
    await sync(db, {
      refused: [refusal("UP-1")],
      liveTicketKeys: ["UP-1"],
    });
    const issueTracker = tracker();
    await notify(db, issueTracker);

    await sync(db, { refused: [], liveTicketKeys: [] });
    await sync(db, {
      refused: [refusal("UP-1")],
      liveTicketKeys: ["UP-1"],
    });

    expect(await notify(db, issueTracker)).toBe(1);
    expect(issueTracker.postComment).toHaveBeenCalledTimes(2);
  });

  it("caps how many tickets one pass comments on", async () => {
    const db = await createTestDb();
    const keys = ["UP-1", "UP-2", "UP-3", "UP-4", "UP-5"];
    await sync(db, {
      refused: keys.map(refusal),
      liveTicketKeys: keys,
    });
    const issueTracker = tracker();

    expect(await notify(db, issueTracker)).toBe(3);
    expect(await notify(db, issueTracker)).toBe(2);
  });

  // Stamping before posting: a comment that fails halfway (or lands while the
  // response is lost) must never turn into a second comment on the same wait.
  it("never retries a comment that failed", async () => {
    const db = await createTestDb();
    await sync(db, {
      refused: [refusal("UP-1")],
      liveTicketKeys: ["UP-1"],
    });
    const issueTracker = {
      postComment: vi.fn(async () => {
        throw new Error("Jira rejected the comment");
      }),
    };

    expect(await notify(db, issueTracker)).toBe(0);
    expect((await listQueuedDispatches(db))[0].notifiedAt).not.toBeNull();
    expect(await notify(db, issueTracker)).toBe(0);
    expect(issueTracker.postComment).toHaveBeenCalledTimes(1);
  });

  it("names the pool in the comment so the wait is self-explanatory", () => {
    expect(formatQueuedComment({ limit: 3, occupied: 3 })).toContain("(3 of 3)");
  });
});
