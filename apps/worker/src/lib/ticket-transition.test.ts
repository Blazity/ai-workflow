import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import { IssueTrackerNotFoundError } from "../adapters/issue-tracker/types.js";

const mocks = vi.hoisted(() => ({
  assertBound: vi.fn(),
  begin: vi.fn(),
  discard: vi.fn(),
  finish: vi.fn(),
  listUnfinished: vi.fn(),
  record: vi.fn(),
  recordParkedStarted: vi.fn(),
}));

vi.mock("./active-run-owner.js", () => ({
  assertActiveRunOwner: (...args: any[]) => mocks.assertBound(...args),
}));

vi.mock("./ticket-transition-intent-store.js", () => ({
  beginTicketTransitionIntent: (...args: any[]) => mocks.begin(...args),
  discardTicketTransitionIntent: (...args: any[]) => mocks.discard(...args),
  finishTicketTransitionIntent: (...args: any[]) => mocks.finish(...args),
  listUnfinishedTicketTransitions: (...args: any[]) => mocks.listUnfinished(...args),
  recordTicketTransitionIntent: (...args: any[]) => mocks.record(...args),
  recordStartedParkedTicketTransitionIntent: (...args: any[]) =>
    mocks.recordParkedStarted(...args),
}));

import {
  moveTicketWithIntent,
  moveTicketWithParkedOwnerIntent,
  reconcileUnfinishedTicketTransitions,
} from "./ticket-transition.js";

const db = {} as never;
const owner = {
  subjectKey: "ticket:jira:AIW-101",
  ownerToken: "owner-1",
  runId: "run-1",
};

function tracker(input: {
  fetchTicket?: ReturnType<typeof vi.fn>;
  moveTicket?: ReturnType<typeof vi.fn>;
  getCurrentUserAccountId?: ReturnType<typeof vi.fn>;
} = {}): IssueTrackerAdapter {
  return {
    fetchTicket:
      input.fetchTicket ??
      vi.fn().mockResolvedValue({ trackerStatus: "In Progress", trackerStatusId: "3" }),
    moveTicket: input.moveTicket ?? vi.fn().mockResolvedValue(undefined),
    getCurrentUserAccountId:
      input.getCurrentUserAccountId ?? vi.fn().mockResolvedValue("jira-bot-account"),
  } as unknown as IssueTrackerAdapter;
}

describe("moveTicketWithIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertBound.mockResolvedValue(undefined);
    mocks.begin.mockResolvedValue(true);
    mocks.discard.mockResolvedValue(true);
    mocks.finish.mockResolvedValue(true);
    mocks.listUnfinished.mockResolvedValue([]);
    mocks.record.mockResolvedValue(7);
    mocks.recordParkedStarted.mockResolvedValue(8);
  });

  it("does not record intent or move when the live ticket is already at target", async () => {
    const issueTracker = tracker({
      fetchTicket: vi
        .fn()
        .mockResolvedValue({ trackerStatus: "Done", trackerStatusId: "10042" }),
    });

    await moveTicketWithIntent({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      target: { name: "Done", statusId: "10042" },
      owner,
    });

    expect(mocks.record).not.toHaveBeenCalled();
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
  });

  it("does not treat a same-name, different-id pre-read as already at target", async () => {
    const issueTracker = tracker({
      fetchTicket: vi
        .fn()
        .mockResolvedValue({ trackerStatus: "Done", trackerStatusId: "99999" }),
    });

    await moveTicketWithIntent({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      target: { name: "Done", statusId: "10042" },
      owner,
    });

    expect(mocks.record).toHaveBeenCalledOnce();
    expect(issueTracker.moveTicket).toHaveBeenCalledOnce();
  });

  it("persists owner intent before calling the provider", async () => {
    const order: string[] = [];
    mocks.record.mockImplementation(async () => {
      order.push("intent");
      return 7;
    });
    mocks.assertBound.mockImplementation(async () => {
      order.push("fence");
    });
    mocks.begin.mockImplementation(async () => {
      order.push("started");
      return true;
    });
    const issueTracker = tracker({
      moveTicket: vi.fn().mockImplementation(async () => {
        order.push("move");
      }),
    });
    mocks.finish.mockImplementation(async () => {
      order.push("finished");
      return true;
    });

    await moveTicketWithIntent({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      target: "Done",
      owner,
    });

    expect(order).toEqual(["intent", "fence", "started", "move", "finished"]);
    expect(mocks.record).toHaveBeenCalledWith(db, {
      actorAccountId: "jira-bot-account",
      ticketKey: "AIW-101",
      target: "Done",
      ...owner,
    });
    expect(mocks.assertBound).toHaveBeenCalledWith(db, owner);
    expect(mocks.begin).toHaveBeenCalledWith(db, 7, owner);
    expect(mocks.finish).toHaveBeenCalledWith(db, 7);
    expect(issueTracker.getCurrentUserAccountId).toHaveBeenCalledOnce();
  });

  it("does not call Jira when cancellation wins the atomic provider-start fence", async () => {
    mocks.begin.mockResolvedValue(false);
    const issueTracker = tracker();

    await expect(
      moveTicketWithIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: "Done",
        owner,
      }),
    ).rejects.toThrow(/provider start fence/i);

    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(mocks.discard).toHaveBeenCalledWith(db, 7);
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("does not call the provider when cancellation closes the owner after intent recording", async () => {
    let ownerState: "bound" | "cancelling" = "bound";
    mocks.record.mockImplementation(async () => {
      ownerState = "cancelling";
      return 7;
    });
    mocks.assertBound.mockImplementation(async () => {
      if (ownerState !== "bound") {
        throw new Error("Ticket transition owner is no longer the exact bound run.");
      }
    });
    const issueTracker = tracker();

    await expect(
      moveTicketWithIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: "Done",
        owner,
      }),
    ).rejects.toThrow(/no longer the exact bound run/i);

    expect(mocks.assertBound).toHaveBeenCalledWith(db, owner);
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(mocks.discard).toHaveBeenCalledWith(db, 7);
  });

  it("fails closed before recording when Jira cannot identify the workflow actor", async () => {
    const issueTracker = tracker({
      getCurrentUserAccountId: vi.fn().mockResolvedValue(""),
    });

    await expect(
      moveTicketWithIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: "Done",
        owner,
      }),
    ).rejects.toThrow(/workflow actor account id/i);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
  });

  it("retains a started intent when one immediate post-error read has not moved yet", async () => {
    const original = new Error("connection reset after request");
    const issueTracker = tracker({
      fetchTicket: vi
        .fn()
        .mockResolvedValue({ trackerStatus: "In Progress", trackerStatusId: "3" }),
      moveTicket: vi.fn().mockRejectedValue(original),
    });

    await expect(
      moveTicketWithIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: "Done",
        owner,
      }),
    ).rejects.toBe(original);
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.discard).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(issueTracker.fetchTicket).toHaveBeenCalledTimes(2);
  });

  it("retains intent and the original error when the post-error read is unavailable", async () => {
    const original = new Error("connection reset after request");
    const issueTracker = tracker({
      fetchTicket: vi
        .fn()
        .mockResolvedValueOnce({ trackerStatus: "In Progress", trackerStatusId: "3" })
        .mockRejectedValueOnce(new Error("Jira unavailable")),
      moveTicket: vi.fn().mockRejectedValue(original),
    });

    await expect(
      moveTicketWithIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: "Done",
        owner,
      }),
    ).rejects.toBe(original);
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.discard).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(issueTracker.fetchTicket).toHaveBeenCalledTimes(2);
  });

  it("resolves success when the post-error live read confirms the target", async () => {
    const issueTracker = tracker({
      fetchTicket: vi
        .fn()
        .mockResolvedValueOnce({ trackerStatus: "In Progress", trackerStatusId: "3" })
        .mockResolvedValueOnce({ trackerStatus: "Done", trackerStatusId: "10042" }),
      moveTicket: vi.fn().mockRejectedValue(new Error("response lost")),
    });

    await expect(
      moveTicketWithIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: { name: "Done", statusId: "10042" },
        owner,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.discard).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(db, 7);
  });

  it("retains a failed move with a same-name, different-id post-read as unresolved", async () => {
    const original = new Error("response lost");
    const issueTracker = tracker({
      fetchTicket: vi
        .fn()
        .mockResolvedValueOnce({ trackerStatus: "In Progress", trackerStatusId: "3" })
        .mockResolvedValueOnce({ trackerStatus: "Done", trackerStatusId: "99999" }),
      moveTicket: vi.fn().mockRejectedValue(original),
    });

    await expect(
      moveTicketWithIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: { name: "Done", statusId: "10042" },
        owner,
      }),
    ).rejects.toBe(original);
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.discard).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("does not record or move when the required pre-read fails", async () => {
    const original = new Error("Jira unavailable");
    const issueTracker = tracker({ fetchTicket: vi.fn().mockRejectedValue(original) });

    await expect(
      moveTicketWithIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: "Done",
        owner,
      }),
    ).rejects.toBe(original);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
  });
});

describe("moveTicketWithParkedOwnerIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finish.mockResolvedValue(true);
    mocks.recordParkedStarted.mockResolvedValue(8);
  });

  it("opens one durable parked-owner provider boundary before re-driving Jira", async () => {
    const order: string[] = [];
    mocks.recordParkedStarted.mockImplementation(async () => {
      order.push("started");
      return 8;
    });
    mocks.finish.mockImplementation(async () => {
      order.push("finished");
      return true;
    });
    const issueTracker = tracker({
      moveTicket: vi.fn().mockImplementation(async () => {
        order.push("move");
      }),
    });

    await moveTicketWithParkedOwnerIntent({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      target: "Backlog",
      owner,
    });

    expect(order).toEqual(["started", "move", "finished"]);
    expect(mocks.recordParkedStarted).toHaveBeenCalledWith(db, {
      actorAccountId: "jira-bot-account",
      ticketKey: "AIW-101",
      target: "Backlog",
      ...owner,
    });
  });

  it("does not call Jira when cancellation closes the parked owner first", async () => {
    mocks.recordParkedStarted.mockRejectedValue(
      new Error("Cannot start ticket transition without the exact parked owner."),
    );
    const issueTracker = tracker();

    await expect(
      moveTicketWithParkedOwnerIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: "Backlog",
        owner,
      }),
    ).rejects.toThrow(/exact parked owner/i);

    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("rechecks Jira after opening the parked fence and skips a move another poll landed", async () => {
    const issueTracker = tracker({
      fetchTicket: vi
        .fn()
        .mockResolvedValueOnce({ trackerStatus: "In Progress", trackerStatusId: "3" })
        .mockResolvedValueOnce({ trackerStatus: "Backlog", trackerStatusId: "10001" }),
    });

    await expect(
      moveTicketWithParkedOwnerIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: "Backlog",
        owner,
      }),
    ).resolves.toBeUndefined();

    expect(mocks.recordParkedStarted).toHaveBeenCalledOnce();
    expect(issueTracker.fetchTicket).toHaveBeenCalledTimes(2);
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(db, 8);
  });

  it("retains an ambiguous parked-owner provider boundary for polling", async () => {
    const original = new Error("response lost");
    const issueTracker = tracker({
      fetchTicket: vi
        .fn()
        .mockResolvedValue({ trackerStatus: "In Progress", trackerStatusId: "3" }),
      moveTicket: vi.fn().mockRejectedValue(original),
    });

    await expect(
      moveTicketWithParkedOwnerIntent({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        target: "Backlog",
        owner,
      }),
    ).rejects.toBe(original);

    expect(mocks.recordParkedStarted).toHaveBeenCalledOnce();
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});

describe("reconcileUnfinishedTicketTransitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finish.mockResolvedValue(true);
  });

  it("settles a reserved owner when live Jira proves an accepted move landed without its finish write", async () => {
    const reservedOwner = { ...owner, runId: null };
    mocks.listUnfinished.mockResolvedValue([
      {
        id: 12,
        target: { name: "AI", statusId: "10010" },
        providerStartedAt: new Date("2026-07-18T12:00:00Z"),
        expiresAt: new Date("2026-07-18T14:00:00Z"),
      },
    ]);
    const issueTracker = tracker({
      fetchTicket: vi.fn().mockResolvedValue({
        trackerStatus: "AI",
        trackerStatusId: "10010",
      }),
    });

    await expect(
      reconcileUnfinishedTicketTransitions({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        owner: reservedOwner,
      }),
    ).resolves.toEqual({
      settled: true,
      settledIntentIds: [12],
      pendingIntentIds: [],
    });
    expect(mocks.listUnfinished).toHaveBeenCalledWith(db, {
      ticketKey: "AIW-101",
      ...reservedOwner,
    });
    expect(mocks.finish).toHaveBeenCalledWith(db, 12);
  });

  it("keeps a nonmatching ambiguous call fenced, then settles it after a late landing", async () => {
    mocks.listUnfinished.mockResolvedValue([
      {
        id: 13,
        target: "Backlog",
        providerStartedAt: new Date("2026-07-18T12:00:00Z"),
        expiresAt: new Date("2026-07-18T14:00:00Z"),
      },
    ]);
    const fetchTicket = vi
      .fn()
      .mockResolvedValueOnce({ trackerStatus: "AI", trackerStatusId: "10010" })
      .mockResolvedValueOnce({ trackerStatus: "Backlog", trackerStatusId: "10001" });
    const issueTracker = tracker({ fetchTicket });

    await expect(
      reconcileUnfinishedTicketTransitions({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        owner,
      }),
    ).resolves.toEqual({
      settled: false,
      settledIntentIds: [],
      pendingIntentIds: [13],
    });
    expect(mocks.finish).not.toHaveBeenCalled();

    await expect(
      reconcileUnfinishedTicketTransitions({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        owner,
      }),
    ).resolves.toMatchObject({ settled: true, settledIntentIds: [13] });
    expect(mocks.finish).toHaveBeenCalledWith(db, 13);
  });

  it("keeps a nonmatching ambiguous call fenced after its retention deadline", async () => {
    mocks.listUnfinished.mockResolvedValue([
      {
        id: 14,
        target: "Backlog",
        providerStartedAt: new Date("2026-07-18T10:00:00Z"),
        expiresAt: new Date("2026-07-18T12:00:00Z"),
      },
    ]);
    const issueTracker = tracker({
      fetchTicket: vi.fn().mockResolvedValue({
        trackerStatus: "Blocked",
        trackerStatusId: "10030",
      }),
    });

    await expect(
      reconcileUnfinishedTicketTransitions({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        owner,
      }),
    ).resolves.toEqual({
      settled: false,
      settledIntentIds: [],
      pendingIntentIds: [14],
    });
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("settles exact unfinished calls when Jira proves the ticket no longer exists", async () => {
    mocks.listUnfinished.mockResolvedValue([
      {
        id: 15,
        target: "Backlog",
        providerStartedAt: new Date("2026-07-18T12:00:00Z"),
        expiresAt: new Date("2026-07-18T14:00:00Z"),
      },
    ]);
    const issueTracker = tracker({
      fetchTicket: vi
        .fn()
        .mockRejectedValue(new IssueTrackerNotFoundError("ticket", "AIW-101")),
    });

    await expect(
      reconcileUnfinishedTicketTransitions({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        owner,
      }),
    ).resolves.toEqual({
      settled: true,
      settledIntentIds: [15],
      pendingIntentIds: [],
    });
    expect(mocks.finish).toHaveBeenCalledWith(db, 15);
  });
});
