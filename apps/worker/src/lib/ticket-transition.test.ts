import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";

const mocks = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock("./ticket-transition-intent-store.js", () => ({
  recordTicketTransitionIntent: (...args: any[]) => mocks.record(...args),
}));

import { moveTicketWithIntent } from "./ticket-transition.js";

const db = {} as never;
const owner = {
  subjectKey: "ticket:jira:AIW-101",
  ownerToken: "owner-1",
  runId: "run-1",
};

function tracker(input: {
  fetchTicket?: ReturnType<typeof vi.fn>;
  moveTicket?: ReturnType<typeof vi.fn>;
} = {}): IssueTrackerAdapter {
  return {
    fetchTicket:
      input.fetchTicket ??
      vi.fn().mockResolvedValue({ trackerStatus: "In Progress", trackerStatusId: "3" }),
    moveTicket: input.moveTicket ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as IssueTrackerAdapter;
}

describe("moveTicketWithIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.record.mockResolvedValue(7);
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
    const issueTracker = tracker({
      moveTicket: vi.fn().mockImplementation(async () => {
        order.push("move");
      }),
    });

    await moveTicketWithIntent({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      target: "Done",
      owner,
    });

    expect(order).toEqual(["intent", "move"]);
    expect(mocks.record).toHaveBeenCalledWith(db, {
      ticketKey: "AIW-101",
      target: "Done",
      ...owner,
    });
  });

  it("retains intent and the original error when a failed call did not reach target", async () => {
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
  });

  it("does not reconcile a failed move from a same-name, different-id post-read", async () => {
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
