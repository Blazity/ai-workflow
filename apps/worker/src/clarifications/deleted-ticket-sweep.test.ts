import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssueTrackerNotFoundError } from "../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import { activeRuns, clarificationRequests, workflowRuns } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { prepareHookClarification, publishHookClarification } from "./hook-store.js";

const mocks = vi.hoisted(() => ({
  retireParkedRun: vi.fn(),
}));

vi.mock("./retire-park.js", () => ({
  retireParkedRun: (...args: unknown[]) => mocks.retireParkedRun(...args),
}));

const { retireParksForDeletedTickets, TICKET_MISSING_CONFIRMATION_MS } = await import(
  "./deleted-ticket-sweep.js"
);

const runRegistry = {} as RunRegistryAdapter;

async function park(
  db: Db,
  opts: { ticketKey: string; runId: string; state?: "bound" | "cancelling" },
): Promise<void> {
  const subjectKey = `ticket:jira:${opts.ticketKey}`;
  await db.insert(activeRuns).values({
    subjectKey,
    ticketKey: opts.ticketKey,
    ownerToken: `owner-${opts.runId}`,
    runId: opts.runId,
    state: opts.state ?? "bound",
    runKind: "ticket",
  });
  const prepared = await prepareHookClarification(db, {
    ticketKey: opts.ticketKey,
    subjectKey,
    runId: opts.runId,
    blockId: "question",
    definitionId: 1,
    definitionVersion: 1,
    questions: ["Which repository?"],
  });
  await publishHookClarification(db, prepared.id);
  await db.insert(workflowRuns).values({
    runId: opts.runId,
    subjectKey,
    ticketKey: opts.ticketKey,
    status: "awaiting",
  });
}

/** Backdate the recorded absence so the confirmation window has elapsed. */
async function ageAbsence(db: Db, runId: string): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({
      ticketMissingSince: new Date(Date.now() - TICKET_MISSING_CONFIRMATION_MS - 1_000),
    })
    .where(eq(clarificationRequests.runId, runId));
}

const absenceMarker = (db: Db, runId: string) =>
  db
    .select({ ticketMissingSince: clarificationRequests.ticketMissingSince })
    .from(clarificationRequests)
    .where(eq(clarificationRequests.runId, runId))
    .then((rows) => rows[0]?.ticketMissingSince ?? null);

function tracker(opts: { absent?: string[]; failing?: string[] } = {}) {
  return {
    fetchTicket: vi.fn(async (ticketKey: string) => {
      if (opts.failing?.includes(ticketKey)) throw new Error("Jira is down");
      if (opts.absent?.includes(ticketKey)) {
        throw new IssueTrackerNotFoundError("Ticket", ticketKey);
      }
      return { key: ticketKey } as never;
    }),
  };
}

const sweep = (db: Db, issueTracker?: ReturnType<typeof tracker>) =>
  retireParksForDeletedTickets({ db, runRegistry, issueTracker });

describe("retireParksForDeletedTickets", () => {
  beforeEach(() => {
    mocks.retireParkedRun.mockReset();
    mocks.retireParkedRun.mockResolvedValue({
      outcome: "cancelled",
      scheduleOccurrenceSettled: null,
    });
  });

  // One 404 is not proof: Jira answers the same way for an issue the token may no
  // longer view, so the first pass only writes down what it saw.
  it("records the first absent reading without retiring the park", async () => {
    const db = await createTestDb();
    await park(db, { ticketKey: "UP-1", runId: "run-1" });

    const result = await sweep(db, tracker({ absent: ["UP-1"] }));

    expect(result).toEqual({ observed: 1, retired: 0 });
    expect(mocks.retireParkedRun).not.toHaveBeenCalled();
    expect(await absenceMarker(db, "run-1")).not.toBeNull();
  });

  it("retires the park once the absence outlives the confirmation window", async () => {
    const db = await createTestDb();
    await park(db, { ticketKey: "UP-1", runId: "run-1" });
    await ageAbsence(db, "run-1");

    const result = await sweep(db, tracker({ absent: ["UP-1"] }));

    expect(result).toEqual({ observed: 1, retired: 1 });
    expect(mocks.retireParkedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        cause: { kind: "ticket_deleted", ticketKey: "UP-1" },
      }),
    );
  });

  it("waits while the recorded absence is still fresh", async () => {
    const db = await createTestDb();
    await park(db, { ticketKey: "UP-1", runId: "run-1" });
    await sweep(db, tracker({ absent: ["UP-1"] }));

    const result = await sweep(db, tracker({ absent: ["UP-1"] }));

    expect(result).toEqual({ observed: 1, retired: 0 });
    expect(mocks.retireParkedRun).not.toHaveBeenCalled();
  });

  // A restored permission (or a Jira that answered wrongly) must reset the clock,
  // otherwise two unrelated blips a day apart would add up to a retirement.
  it("forgets the absence when the ticket reads back", async () => {
    const db = await createTestDb();
    await park(db, { ticketKey: "UP-1", runId: "run-1" });
    await ageAbsence(db, "run-1");

    const result = await sweep(db, tracker());

    expect(result).toEqual({ observed: 0, retired: 0 });
    expect(await absenceMarker(db, "run-1")).toBeNull();
    expect(mocks.retireParkedRun).not.toHaveBeenCalled();
  });

  it("treats any other tracker failure as no evidence at all", async () => {
    const db = await createTestDb();
    await park(db, { ticketKey: "UP-1", runId: "run-1" });

    const result = await sweep(db, tracker({ failing: ["UP-1"] }));

    expect(result).toEqual({ observed: 0, retired: 0 });
    expect(await absenceMarker(db, "run-1")).toBeNull();
  });

  it("does nothing without a tracker, which cannot tell absent from unreachable", async () => {
    const db = await createTestDb();
    await park(db, { ticketKey: "UP-1", runId: "run-1" });
    await ageAbsence(db, "run-1");

    expect(await sweep(db, undefined)).toEqual({ observed: 0, retired: 0 });
    expect(mocks.retireParkedRun).not.toHaveBeenCalled();
  });

  // A claim already being torn down needs no help, and its slot is on its way
  // back regardless of what the tracker says about the ticket.
  it("ignores a park whose claim is no longer bound", async () => {
    const db = await createTestDb();
    await park(db, { ticketKey: "UP-1", runId: "run-1", state: "cancelling" });
    const issueTracker = tracker({ absent: ["UP-1"] });

    expect(await sweep(db, issueTracker)).toEqual({ observed: 0, retired: 0 });
    expect(issueTracker.fetchTicket).not.toHaveBeenCalled();
  });

  it("caps how many parks one pass may retire", async () => {
    const db = await createTestDb();
    const absent: string[] = [];
    for (const index of [1, 2, 3, 4]) {
      await park(db, { ticketKey: `UP-${index}`, runId: `run-${index}` });
      await ageAbsence(db, `run-${index}`);
      absent.push(`UP-${index}`);
    }

    const result = await sweep(db, tracker({ absent }));

    expect(result).toEqual({ observed: 4, retired: 3 });
    expect(mocks.retireParkedRun).toHaveBeenCalledTimes(3);
  });

  // An unconfirmed cancel never touched the run, so the marker has to stay for
  // the next pass to retry: clearing it would restart the whole waiting period.
  it("keeps the absence marker when the cancellation is unconfirmed", async () => {
    const db = await createTestDb();
    await park(db, { ticketKey: "UP-1", runId: "run-1" });
    await ageAbsence(db, "run-1");
    mocks.retireParkedRun.mockResolvedValue({
      outcome: "unconfirmed",
      scheduleOccurrenceSettled: null,
    });

    const result = await sweep(db, tracker({ absent: ["UP-1"] }));

    expect(result).toEqual({ observed: 1, retired: 0 });
    expect(await absenceMarker(db, "run-1")).not.toBeNull();
  });
});
