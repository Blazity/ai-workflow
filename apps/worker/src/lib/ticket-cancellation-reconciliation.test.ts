import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";

const mocks = vi.hoisted(() => ({
  discardIntent: vi.fn(),
  finishIntent: vi.fn(),
  getFence: vi.fn(),
  getMutationVersion: vi.fn(),
  listLateTargets: vi.fn(),
  listUnfinished: vi.fn(),
  recordReconciliationIntent: vi.fn(),
  reconcileLabels: vi.fn(),
  updateLabelsWithIntent: vi.fn(),
}));

vi.mock("./ticket-transition-intent-store.js", () => ({
  discardTicketTransitionIntent: (...args: any[]) => mocks.discardIntent(...args),
  finishTicketTransitionIntent: (...args: any[]) => mocks.finishIntent(...args),
  getTicketCancellationFence: (...args: any[]) => mocks.getFence(...args),
  getTicketMutationVersion: (...args: any[]) => mocks.getMutationVersion(...args),
  listPotentialLateTicketTransitionTargets: (...args: any[]) =>
    mocks.listLateTargets(...args),
  listUnfinishedTicketTransitions: (...args: any[]) => mocks.listUnfinished(...args),
  recordStartedTicketReconciliationIntent: (...args: any[]) =>
    mocks.recordReconciliationIntent(...args),
}));

vi.mock("./ticket-label-mutation.js", () => ({
  reconcileUnfinishedTicketLabelMutations: (...args: any[]) =>
    mocks.reconcileLabels(...args),
  updateTicketLabelsWithIntent: (...args: any[]) =>
    mocks.updateLabelsWithIntent(...args),
}));

import { reconcileTicketCancellationAfterDrain } from "./ticket-cancellation-reconciliation.js";

const db = {} as never;
const owner = {
  subjectKey: "ticket:jira:AIW-101",
  ownerToken: "owner-1",
  runId: "run-1",
};
const humanMoveAt = new Date("2026-07-18T12:00:00.000Z");

function tracker(input: {
  fetchTicket?: ReturnType<typeof vi.fn>;
  moveTicket?: ReturnType<typeof vi.fn>;
  updateLabels?: ReturnType<typeof vi.fn>;
} = {}): IssueTrackerAdapter {
  return {
    fetchTicket:
      input.fetchTicket ??
      vi.fn().mockResolvedValue({
        trackerStatus: "AI Review",
        trackerStatusId: "10020",
        labels: ["needs-clarification", "awaiting-approval", "customer-priority"],
      }),
    moveTicket: input.moveTicket ?? vi.fn().mockResolvedValue(undefined),
    updateLabels: input.updateLabels ?? vi.fn().mockResolvedValue(undefined),
    getCurrentUserAccountId: vi.fn().mockResolvedValue("jira-bot-account"),
  } as unknown as IssueTrackerAdapter;
}

describe("reconcileTicketCancellationAfterDrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discardIntent.mockResolvedValue(true);
    mocks.finishIntent.mockResolvedValue(true);
    mocks.getMutationVersion.mockResolvedValue(7);
    mocks.getFence.mockResolvedValue({
      id: 11,
      target: { name: "Backlog", statusId: "10001" },
      occurredAt: humanMoveAt,
      createdAt: new Date("2026-07-18T12:02:00.000Z"),
    });
    mocks.listLateTargets.mockResolvedValue([
      {
        id: 7,
        target: { name: "AI Review", statusId: "10020" },
        providerFinishedAt: new Date("2026-07-18T12:00:01.000Z"),
      },
    ]);
    mocks.listUnfinished.mockResolvedValue([]);
    mocks.recordReconciliationIntent.mockResolvedValue(8);
    mocks.reconcileLabels.mockResolvedValue({
      settled: true,
      settledIntentIds: [],
      pendingIntentIds: [],
    });
    mocks.updateLabelsWithIntent.mockResolvedValue(undefined);
  });

  it("restores the human destination after a late workflow move and removes only workflow-owned labels", async () => {
    const issueTracker = tracker();

    await expect(reconcileTicketCancellationAfterDrain({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      owner,
    })).resolves.toEqual({
      latestFenceId: 11,
      hasHumanFence: true,
      mutationVersion: 7,
    });

    expect(mocks.listLateTargets).toHaveBeenCalledWith(db, {
      ...owner,
      ticketKey: "AIW-101",
      finishedAfter: new Date("2026-07-18T11:55:00.000Z"),
    });
    expect(mocks.recordReconciliationIntent).toHaveBeenCalledWith(db, {
      ...owner,
      ticketKey: "AIW-101",
      actorAccountId: "jira-bot-account",
      target: { name: "Backlog", statusId: "10001" },
    });
    expect(issueTracker.moveTicket).toHaveBeenCalledWith("AIW-101", {
      name: "Backlog",
      statusId: "10001",
    });
    expect(mocks.finishIntent).toHaveBeenCalledWith(db, 8);
    expect(mocks.updateLabelsWithIntent).toHaveBeenCalledWith({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "cancelling",
      changes: { remove: ["needs-clarification", "awaiting-approval"] },
    });
    expect(issueTracker.updateLabels).not.toHaveBeenCalled();
    expect(mocks.getMutationVersion).toHaveBeenCalledWith(db, owner);
  });

  it("preserves a newer human destination instead of restoring over it", async () => {
    const issueTracker = tracker({
      fetchTicket: vi.fn().mockResolvedValue({
        trackerStatus: "Blocked",
        trackerStatusId: "10030",
        labels: ["needs-clarification", "customer-priority"],
      }),
    });

    await reconcileTicketCancellationAfterDrain({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      owner,
    });

    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(mocks.recordReconciliationIntent).not.toHaveBeenCalled();
    expect(mocks.updateLabelsWithIntent).toHaveBeenCalledWith({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "cancelling",
      changes: { remove: ["needs-clarification"] },
    });
  });

  it("does not remove a workflow label that is absent from the post-drain snapshot", async () => {
    const issueTracker = tracker({
      fetchTicket: vi.fn().mockResolvedValue({
        trackerStatus: "Backlog",
        trackerStatusId: "10001",
        labels: ["customer-priority"],
      }),
    });

    await reconcileTicketCancellationAfterDrain({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      owner,
    });

    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(mocks.updateLabelsWithIntent).not.toHaveBeenCalled();
  });

  it("removes stale workflow-owned labels after operator cancellation without a human status fence", async () => {
    mocks.getFence.mockResolvedValue(null);
    const issueTracker = tracker({
      fetchTicket: vi.fn().mockResolvedValue({
        trackerStatus: "AI",
        trackerStatusId: "10010",
        labels: ["awaiting-approval", "customer-priority"],
      }),
    });

    await reconcileTicketCancellationAfterDrain({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      owner,
    });

    expect(mocks.listLateTargets).not.toHaveBeenCalled();
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(mocks.updateLabelsWithIntent).toHaveBeenCalledWith({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "cancelling",
      changes: { remove: ["awaiting-approval"] },
    });
  });

  it("keeps a reserved cancellation closed while its provider call is still in flight", async () => {
    mocks.listLateTargets.mockResolvedValue([
      {
        id: 7,
        target: { name: "AI", statusId: "10010" },
        providerFinishedAt: null,
      },
    ]);
    const issueTracker = tracker({
      fetchTicket: vi.fn().mockResolvedValue({
        trackerStatus: "Backlog",
        trackerStatusId: "10001",
        labels: [],
      }),
    });

    await expect(
      reconcileTicketCancellationAfterDrain({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        owner: { ...owner, runId: null },
      }),
    ).rejects.toThrow(/provider transition is still in flight/i);
    expect(issueTracker.fetchTicket).not.toHaveBeenCalled();
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(mocks.updateLabelsWithIntent).not.toHaveBeenCalled();
  });

  it("keeps a bound cancellation closed while a concurrent compensating move is still in flight", async () => {
    mocks.listLateTargets.mockResolvedValue([
      {
        id: 8,
        target: { name: "Backlog", statusId: "10001" },
        providerFinishedAt: null,
      },
    ]);
    const issueTracker = tracker();

    await expect(
      reconcileTicketCancellationAfterDrain({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        owner,
      }),
    ).rejects.toThrow(/provider transition is still in flight/i);
    expect(issueTracker.fetchTicket).not.toHaveBeenCalled();
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(mocks.updateLabelsWithIntent).not.toHaveBeenCalled();
  });

  it("keeps cancellation closed while an exact label provider call is still in flight", async () => {
    mocks.reconcileLabels.mockResolvedValue({
      settled: false,
      settledIntentIds: [],
      pendingIntentIds: [12],
    });
    const issueTracker = tracker();

    await expect(
      reconcileTicketCancellationAfterDrain({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        owner,
      }),
    ).rejects.toThrow(/label mutation is still in flight/i);

    expect(issueTracker.fetchTicket).not.toHaveBeenCalled();
    expect(mocks.updateLabelsWithIntent).not.toHaveBeenCalled();
  });

  it("finishes reconciliation when the ticket was deleted after provider intents settled", async () => {
    const issueTracker = tracker({
      fetchTicket: vi.fn().mockRejectedValue(
        new IssueTrackerNotFoundError("ticket", "AIW-101"),
      ),
    });

    await expect(
      reconcileTicketCancellationAfterDrain({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        owner,
      }),
    ).resolves.toEqual({
      latestFenceId: 11,
      hasHumanFence: true,
      mutationVersion: 7,
      ticketMissing: true,
    });

    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(mocks.updateLabelsWithIntent).not.toHaveBeenCalled();
    expect(mocks.getMutationVersion).toHaveBeenCalledWith(db, owner);
  });

  it("keeps cancellation quarantined when an ambiguous provider transition expires", async () => {
    const expiresAt = new Date("2026-07-18T11:59:00.000Z");
    mocks.listUnfinished.mockResolvedValue([
      {
        id: 7,
        target: { name: "AI", statusId: "10010" },
        providerStartedAt: new Date("2026-07-18T10:00:00.000Z"),
        expiresAt,
      },
    ]);
    const issueTracker = tracker({
      fetchTicket: vi.fn().mockResolvedValue({
        trackerStatus: "Backlog",
        trackerStatusId: "10001",
        labels: [],
      }),
    });

    await expect(
      reconcileTicketCancellationAfterDrain({
        db,
        issueTracker,
        ticketKey: "AIW-101",
        owner,
        now: new Date("2026-07-18T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/provider transition is still in flight/i);

    expect(mocks.finishIntent).not.toHaveBeenCalled();
    expect(mocks.listLateTargets).not.toHaveBeenCalled();
  });
});
