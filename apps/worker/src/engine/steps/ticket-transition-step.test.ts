import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  moveTicket: vi.fn(),
  board: vi.fn(),
  settings: vi.fn(),
  issueTracker: {},
  db: {},
}));

vi.mock("../../db/client.js", () => ({ getDb: () => mocks.db }));
vi.mock("../../engine/support/adapters.js", () => ({
  createAdapters: () => ({ issueTracker: mocks.issueTracker }),
}));
vi.mock("../../engine/support/ticket-transition.js", () => ({
  moveTicketForRun: (...args: any[]) => mocks.moveTicket(...args),
  moveConnectedTicketForRun: (...args: any[]) => mocks.moveTicket(...args),
}));
// The board as this deployment is wired right now, which is what completes a
// bare column name that a run recorded before it had any wiring to record:
// the operator's columns from the settings rows, the transition ids from the
// tracker's connection.
vi.mock("../../db/repositories/settings.js", () => ({
  readAllConnectedSettings: (...args: any[]) => mocks.settings(...args),
}));
vi.mock("../../infra/settings-environment.js", () => ({
  settingsEnvironment: { value: () => undefined, isSet: () => false },
}));
vi.mock("../support/issue-tracker-runtime.js", () => ({
  issueTrackerWiring: (...args: any[]) => mocks.board(...args),
}));

import { moveTicketStep } from "./ticket-transition-step.js";

describe("moveTicketStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moveTicket.mockResolvedValue(undefined);
    mocks.settings.mockResolvedValue([
      { key: "COLUMN_AI", value: "AI" },
      { key: "COLUMN_AI_REVIEW", value: "AI Review" },
      { key: "COLUMN_BACKLOG", value: "Backlog" },
    ]);
    mocks.board.mockResolvedValue({
      projectKey: "AIW",
      baseUrl: "https://acme.example",
      aiReviewTransitionId: "31",
    });
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
      issueTracker: mocks.issueTracker,
      ticketKey: "AIW-101",
      target,
      owner,
    });
  });

  // A run suspended before S12 replays a result with no tracker wiring, so
  // every transition id is absent and a bare column name arrives here. On a
  // board that localizes transition names, moving by name finds nothing and
  // the ticket is stranded at the end of a run that otherwise worked.
  it("completes a bare column name with the id this board holds for it", async () => {
    const owner = {
      subjectKey: "ticket:jira:AIW-101",
      ownerToken: "owner-1",
      runId: null,
    };

    await moveTicketStep("AIW-101", "AI Review", owner);

    expect(mocks.moveTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { name: "AI Review", transitionId: "31" },
      }),
    );
  });

  it("leaves a name this board has no transition for as a name", async () => {
    // A board that moves by status name configures none for that column.
    const owner = {
      subjectKey: "ticket:jira:AIW-101",
      ownerToken: "owner-1",
      runId: null,
    };

    await moveTicketStep("AIW-101", "Backlog", owner);

    expect(mocks.moveTicket).toHaveBeenCalledWith(
      expect.objectContaining({ target: "Backlog" }),
    );
  });

  it("leaves a name that is no longer on this board as a name", async () => {
    // The renamed-column case, which the rule above only claimed to cover.
    // The run froze "Weryfikacja"; the operator has since renamed that column,
    // so nothing on the board answers to it and there is no id to borrow.
    const owner = {
      subjectKey: "ticket:jira:AIW-101",
      ownerToken: "owner-1",
      runId: null,
    };

    await moveTicketStep("AIW-101", "Weryfikacja", owner);

    expect(mocks.moveTicket).toHaveBeenCalledWith(
      expect.objectContaining({ target: "Weryfikacja" }),
    );
  });

  it("matches a column name whose case or spacing drifted", async () => {
    // The reconciler compares these values trimmed and lowercased; comparing
    // them exactly here would drop the completion on a deployment whose stored
    // value differs only in case, which is not a difference anybody made.
    mocks.settings.mockResolvedValue([
      { key: "COLUMN_AI", value: "AI" },
      { key: "COLUMN_AI_REVIEW", value: " ai review " },
      { key: "COLUMN_BACKLOG", value: "Backlog" },
    ]);
    const owner = {
      subjectKey: "ticket:jira:AIW-101",
      ownerToken: "owner-1",
      runId: null,
    };

    await moveTicketStep("AIW-101", "AI Review", owner);

    expect(mocks.moveTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { name: "AI Review", transitionId: "31" },
      }),
    );
  });

  it("refuses to guess when two columns now answer to the same name", async () => {
    // An operator renames the AI column to what the review column used to be
    // called. Taking the first match would hand a finished run the AI
    // transition, its success move would put the ticket back in the AI column,
    // and the poller would start a second run on work that is already done.
    mocks.settings.mockResolvedValue([
      { key: "COLUMN_AI", value: "AI Review" },
      { key: "COLUMN_AI_REVIEW", value: "AI Review" },
      { key: "COLUMN_BACKLOG", value: "Backlog" },
    ]);
    mocks.board.mockResolvedValue({
      projectKey: "AIW",
      baseUrl: "https://acme.example",
      aiTransitionId: "21",
      aiReviewTransitionId: "31",
    });
    const owner = {
      subjectKey: "ticket:jira:AIW-101",
      ownerToken: "owner-1",
      runId: null,
    };

    await moveTicketStep("AIW-101", "AI Review", owner);

    expect(mocks.moveTicket).toHaveBeenCalledWith(
      expect.objectContaining({ target: "AI Review" }),
    );
  });

  it("moves by name when the settings read fails", async () => {
    // The move this completes is usually the last thing a successful run does.
    // Losing it to a settings blip is the most expensive moment to fail, and
    // moving by name is what every run did before this existed.
    mocks.settings.mockRejectedValue(new Error("db down"));
    const owner = {
      subjectKey: "ticket:jira:AIW-101",
      ownerToken: "owner-1",
      runId: null,
    };

    await moveTicketStep("AIW-101", "AI Review", owner);

    expect(mocks.moveTicket).toHaveBeenCalledWith(
      expect.objectContaining({ target: "AI Review" }),
    );
  });

  it("never rewrites a target whose own run already froze an id", async () => {
    const owner = {
      subjectKey: "ticket:jira:AIW-101",
      ownerToken: "owner-1",
      runId: null,
    };

    await moveTicketStep("AIW-101", { name: "AI Review", transitionId: "99" }, owner);

    expect(mocks.moveTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { name: "AI Review", transitionId: "99" },
      }),
    );
    expect(mocks.board).not.toHaveBeenCalled();
  });

  it("moves by name when this deployment has no tracker to ask", async () => {
    mocks.board.mockRejectedValue(new Error("No issue tracker is connected."));
    const owner = {
      subjectKey: "ticket:jira:AIW-101",
      ownerToken: "owner-1",
      runId: null,
    };

    await moveTicketStep("AIW-101", "AI Review", owner);

    expect(mocks.moveTicket).toHaveBeenCalledWith(
      expect.objectContaining({ target: "AI Review" }),
    );
  });
});
