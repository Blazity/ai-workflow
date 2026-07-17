import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  moveTicketWithIntent: vi.fn(),
  issueTracker: {},
  db: {},
}));

vi.mock("../db/client.js", () => ({ getDb: () => mocks.db }));
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ issueTracker: mocks.issueTracker }),
}));
vi.mock("../lib/ticket-transition.js", () => ({
  moveTicketWithIntent: (...args: any[]) => mocks.moveTicketWithIntent(...args),
}));

import { moveTicketWithIntentStep } from "./ticket-transition-step.js";

describe("moveTicketWithIntentStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moveTicketWithIntent.mockResolvedValue(undefined);
  });

  it("passes serializable arguments into the provider-neutral operation", async () => {
    const owner = {
      subjectKey: "ticket:jira:AIW-101",
      ownerToken: "owner-1",
      runId: null,
    };
    const target = { name: "AI", statusId: "10010" };

    await moveTicketWithIntentStep("AIW-101", target, owner);

    expect(mocks.moveTicketWithIntent).toHaveBeenCalledWith({
      db: mocks.db,
      issueTracker: mocks.issueTracker,
      ticketKey: "AIW-101",
      target,
      owner,
    });
  });
});
