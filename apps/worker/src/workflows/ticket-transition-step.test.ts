import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  moveTicket: vi.fn(),
  fetchTicket: vi.fn(),
  record: vi.fn(),
  discard: vi.fn(),
  db: {},
}));

vi.mock("../db/client.js", () => ({ getDb: () => mocks.db }));
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({
    issueTracker: { moveTicket: mocks.moveTicket, fetchTicket: mocks.fetchTicket },
  }),
}));
vi.mock("../lib/ticket-transition-intent-store.js", () => ({
  recordTicketTransitionIntent: (...args: any[]) => mocks.record(...args),
  discardTicketTransitionIntent: (...args: any[]) => mocks.discard(...args),
}));

import { moveTicketWithIntentStep } from "./agent.js";

const owner = {
  subjectKey: "ticket:jira:AIW-101",
  ownerToken: "owner-1",
  runId: "run-1",
};

describe("moveTicketWithIntentStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.record.mockResolvedValue(7);
    mocks.moveTicket.mockResolvedValue(undefined);
    mocks.fetchTicket.mockResolvedValue({ trackerStatus: "In Progress", trackerStatusId: "3" });
    mocks.discard.mockResolvedValue(undefined);
  });

  it("persists the intent before calling the ticket provider", async () => {
    await moveTicketWithIntentStep("AIW-101", { name: "10042", statusId: "10042" }, owner);

    expect(mocks.record).toHaveBeenCalledWith(mocks.db, {
      ticketKey: "AIW-101",
      ...owner,
      target: { name: "10042", statusId: "10042" },
    });
    expect(mocks.record.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.moveTicket.mock.invocationCallOrder[0],
    );
  });

  it("discards the intent when the provider transition fails", async () => {
    mocks.moveTicket.mockRejectedValueOnce(new Error("Jira failed"));

    await expect(
      moveTicketWithIntentStep("AIW-101", "Done", owner),
    ).rejects.toThrow("Jira failed");
    expect(mocks.discard).toHaveBeenCalledWith(mocks.db, 7);
  });

  it("reconciles an ambiguous provider failure when the transition actually landed", async () => {
    mocks.fetchTicket
      .mockResolvedValueOnce({ trackerStatus: "In Progress", trackerStatusId: "3" })
      .mockResolvedValueOnce({ trackerStatus: "Done", trackerStatusId: "10042" });
    mocks.moveTicket.mockRejectedValueOnce(new Error("connection reset after response"));

    await expect(
      moveTicketWithIntentStep(
        "AIW-101",
        { name: "10042", statusId: "10042" },
        owner,
      ),
    ).resolves.toBeUndefined();
    expect(mocks.discard).not.toHaveBeenCalled();
  });

  it("reconciles a replay that already reached the destination", async () => {
    mocks.fetchTicket.mockResolvedValueOnce({ trackerStatus: "Done", trackerStatusId: "10042" });

    await moveTicketWithIntentStep("AIW-101", { name: "10042", statusId: "10042" }, owner);

    expect(mocks.moveTicket).not.toHaveBeenCalled();
    expect(mocks.discard).not.toHaveBeenCalled();
  });
});
