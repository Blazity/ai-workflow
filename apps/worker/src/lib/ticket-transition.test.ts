import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssueTrackerNotFoundError } from "../adapters/issue-tracker/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";

const assertOwner = vi.hoisted(() => vi.fn());
vi.mock("./active-run-owner.js", () => ({ assertActiveRunOwnerState: assertOwner }));

import {
  moveTicketForRun,
  withdrawTicketFromAiForRun,
} from "./ticket-transition.js";

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

describe("withdrawTicketFromAiForRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertOwner.mockResolvedValue(undefined);
  });

  it("moves an AI-column ticket only while the exact cancelling owner is held", async () => {
    const order: string[] = [];
    assertOwner.mockImplementation(async () => { order.push("owner"); });
    const issueTracker = tracker(
      vi.fn().mockResolvedValue({ trackerStatus: "AI" }),
      vi.fn().mockImplementation(async () => { order.push("move"); }),
    );

    await withdrawTicketFromAiForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      aiColumn: "AI",
      target: "Backlog",
      owner,
      requiredOwnerState: "cancelling",
    });

    expect(order).toEqual(["owner", "move"]);
    expect(issueTracker.moveTicket).toHaveBeenCalledWith("AIW-101", "Backlog");
  });

  it("preserves a workflow-selected destination outside AI", async () => {
    const issueTracker = tracker(
      vi.fn().mockResolvedValue({ trackerStatus: "Review" }),
    );

    await withdrawTicketFromAiForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      aiColumn: "AI",
      target: "Backlog",
      owner,
      requiredOwnerState: "bound",
    });

    expect(assertOwner).toHaveBeenCalledWith(db, owner, "bound");
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
  });

  it.each(["typed error", "error code"])(
    "treats a deleted ticket as outside AI while still fencing the %s",
    async (notFoundShape) => {
      const notFound = notFoundShape === "typed error"
        ? new IssueTrackerNotFoundError("Jira issue", "AIW-101")
        : Object.assign(new Error("gone"), { code: "NOT_FOUND" });
      const issueTracker = tracker(vi.fn().mockRejectedValue(notFound));

      await expect(
        withdrawTicketFromAiForRun({
          db,
          issueTracker,
          ticketKey: "AIW-101",
          aiColumn: "AI",
          target: "Backlog",
          owner,
          requiredOwnerState: "cancelling",
        }),
      ).resolves.toBeUndefined();

      expect(assertOwner).toHaveBeenCalledWith(db, owner, "cancelling");
      expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    },
  );

  it("accepts an ambiguous move when a fresh read confirms the ticket left AI", async () => {
    const fetchTicket = vi.fn()
      .mockResolvedValueOnce({ trackerStatus: "AI" })
      .mockResolvedValueOnce({ trackerStatus: "Review" });
    const issueTracker = tracker(
      fetchTicket,
      vi.fn().mockRejectedValue(new Error("response lost")),
    );

    await expect(withdrawTicketFromAiForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      aiColumn: "AI",
      target: "Backlog",
      owner,
      requiredOwnerState: "bound",
    })).resolves.toBeUndefined();
    expect(fetchTicket).toHaveBeenCalledTimes(2);
  });

  it.each(["AI", "unreadable"])(
    "propagates the original move error when the post-error read is %s",
    async (postErrorStatus) => {
      const moveError = new Error("response lost");
      const fetchTicket = postErrorStatus === "AI"
        ? vi.fn()
            .mockResolvedValueOnce({ trackerStatus: "AI" })
            .mockResolvedValueOnce({ trackerStatus: "AI" })
        : vi.fn()
            .mockResolvedValueOnce({ trackerStatus: "AI" })
            .mockRejectedValueOnce(new Error("read lost"));
      const issueTracker = tracker(
        fetchTicket,
        vi.fn().mockRejectedValue(moveError),
      );

      await expect(withdrawTicketFromAiForRun({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        aiColumn: "AI",
        target: "Backlog",
        owner,
        requiredOwnerState: "bound",
      })).rejects.toBe(moveError);
    },
  );
});
