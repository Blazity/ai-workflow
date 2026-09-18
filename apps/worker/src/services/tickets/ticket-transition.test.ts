import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssueTrackerNotFoundError } from "../../adapters/issue-tracker/types.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";

const assertOwner = vi.hoisted(() => vi.fn());
vi.mock("../../db/repositories/active-runs.js", () => ({ assertActiveRunOwnerState: assertOwner }));

import {
  moveTicketForRun,
  withdrawConnectedTicketFromAiForRun,
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

    expect(assertOwner).toHaveBeenCalledWith(owner, "bound", db);
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
    expect(assertOwner).toHaveBeenCalledWith(owner, "cancelling", db);
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

    await expect(withdrawTicketFromAiForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      aiColumn: "AI",
      target: "Backlog",
      owner,
      requiredOwnerState: "cancelling",
    })).resolves.toBe(true);

    expect(order).toEqual(["owner", "move"]);
    expect(issueTracker.moveTicket).toHaveBeenCalledWith("AIW-101", "Backlog");
  });

  it("preserves a workflow-selected destination outside AI", async () => {
    const issueTracker = tracker(
      vi.fn().mockResolvedValue({ trackerStatus: "Review" }),
    );

    await expect(withdrawTicketFromAiForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      aiColumn: "AI",
      target: "Backlog",
      owner,
      requiredOwnerState: "bound",
    })).resolves.toBe(false);

    expect(assertOwner).toHaveBeenCalledWith(owner, "bound", db);
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
      ).resolves.toBe(false);

      expect(assertOwner).toHaveBeenCalledWith(owner, "cancelling", db);
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
    })).resolves.toBe(true);
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

// WHAT A WITHDRAW REPORTS, on both variants: the connected one is a second copy
// of the same branches and is the one production uses. A caller that tells a
// person where their ticket went reads this boolean and nothing else.
type WithdrawInput = Omit<Parameters<typeof withdrawTicketFromAiForRun>[0], "db">;
describe.each([
  ["withdrawTicketFromAiForRun", (input: WithdrawInput) => withdrawTicketFromAiForRun({ db, ...input })],
  ["withdrawConnectedTicketFromAiForRun", (input: WithdrawInput) => withdrawConnectedTicketFromAiForRun(input)],
])("%s reports whether it moved the ticket", (_name, withdraw) => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertOwner.mockResolvedValue(undefined);
  });

  const notFound = () => new IssueTrackerNotFoundError("Jira issue", "AIW-101");

  it.each([
    {
      case: "moved out of AI",
      fetchTicket: () => vi.fn().mockResolvedValue({ trackerStatus: "AI" }),
      moveTicket: () => vi.fn().mockResolvedValue(undefined),
      moved: true,
    },
    {
      case: "already outside AI at the read",
      fetchTicket: () => vi.fn().mockResolvedValue({ trackerStatus: "Review" }),
      moveTicket: () => vi.fn(),
      moved: false,
    },
    {
      case: "ticket gone at the read",
      fetchTicket: () => vi.fn().mockRejectedValue(notFound()),
      moveTicket: () => vi.fn(),
      moved: false,
    },
    {
      case: "move lost its response and a fresh read proves the ticket left AI",
      fetchTicket: () =>
        vi.fn()
          .mockResolvedValueOnce({ trackerStatus: "AI" })
          .mockResolvedValueOnce({ trackerStatus: "Backlog" }),
      moveTicket: () => vi.fn().mockRejectedValue(new Error("response lost")),
      moved: true,
    },
    {
      case: "move failed and the ticket is gone at the fresh read",
      fetchTicket: () =>
        vi.fn()
          .mockResolvedValueOnce({ trackerStatus: "AI" })
          .mockRejectedValueOnce(notFound()),
      moveTicket: () => vi.fn().mockRejectedValue(new Error("response lost")),
      moved: false,
    },
  ])("$case: $moved", async ({ fetchTicket, moveTicket, moved }) => {
    const issueTracker = tracker(fetchTicket(), moveTicket());

    await expect(withdraw({
      issueTracker,
      ticketKey: "AIW-101",
      aiColumn: "AI",
      target: "Backlog",
      owner,
      requiredOwnerState: "bound",
    })).resolves.toBe(moved);
  });
});
