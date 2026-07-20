import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";

const assertOwner = vi.hoisted(() => vi.fn());
vi.mock("./active-run-owner.js", () => ({ assertActiveRunOwnerState: assertOwner }));

import { moveTicketForRun } from "./ticket-transition.js";

const db = {} as never;
const owner = {
  subjectKey: "ticket:jira:AIW-101",
  ownerToken: "owner-1",
  runId: "run-1",
};

function tracker(fetchTicket: ReturnType<typeof vi.fn>, moveTicket = vi.fn()) {
  return { fetchTicket, moveTicket } as unknown as IssueTrackerAdapter;
}

describe("moveTicketForRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertOwner.mockResolvedValue(undefined);
  });

  it("checks the exact owner and skips an already satisfied target", async () => {
    const issueTracker = tracker(
      vi.fn().mockResolvedValue({ trackerStatus: "Done", trackerStatusId: "42" }),
    );
    await moveTicketForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      target: { name: "Done", statusId: "42" },
      owner,
    });

    expect(assertOwner).toHaveBeenCalledWith(db, owner, "bound");
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
  });

  it("checks ownership before moving", async () => {
    const order: string[] = [];
    assertOwner.mockImplementation(async () => { order.push("owner"); });
    const issueTracker = tracker(
      vi.fn().mockResolvedValue({ trackerStatus: "In Progress", trackerStatusId: "3" }),
      vi.fn().mockImplementation(async () => { order.push("move"); }),
    );
    await moveTicketForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      target: "Done",
      owner,
    });

    expect(order).toEqual(["owner", "move"]);
  });

  it("accepts a lost provider response only when a fresh read proves the target", async () => {
    const fetchTicket = vi.fn()
      .mockResolvedValueOnce({ trackerStatus: "In Progress" })
      .mockResolvedValueOnce({ trackerStatus: "Done" });
    const issueTracker = tracker(fetchTicket, vi.fn().mockRejectedValue(new Error("timeout")));

    await expect(moveTicketForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      target: "Done",
      owner,
    })).resolves.toBeUndefined();
  });

  it("supports the exact cancelling owner for compatibility moves", async () => {
    const issueTracker = tracker(vi.fn().mockResolvedValue({ trackerStatus: "AI" }));
    await moveTicketForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      target: "Backlog",
      owner,
      requiredOwnerState: "cancelling",
    });
    expect(assertOwner).toHaveBeenCalledWith(db, owner, "cancelling");
  });
});
