import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  moveTicket: vi.fn(),
  issueTracker: {},
  db: {},
}));

vi.mock("../db/client.js", () => ({ getDb: () => mocks.db }));
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ issueTracker: mocks.issueTracker }),
}));
vi.mock("../lib/ticket-transition.js", () => ({
  moveTicketForRun: (...args: any[]) => mocks.moveTicket(...args),
}));

import { moveTicketStep } from "./ticket-transition-step.js";

describe("moveTicketStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moveTicket.mockResolvedValue(undefined);
  });

  it("passes serializable arguments into the provider-neutral operation", async () => {
    const owner = {
      subjectKey: "ticket:jira:AIW-101",
      ownerToken: "owner-1",
      runId: null,
    };
    const target = { name: "AI", statusId: "10010" };

    await moveTicketStep("AIW-101", target, owner);

    expect(mocks.moveTicket).toHaveBeenCalledWith({
      db: mocks.db,
      issueTracker: mocks.issueTracker,
      ticketKey: "AIW-101",
      target,
      owner,
    });
  });
});
