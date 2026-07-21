import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";

const assertOwner = vi.hoisted(() => vi.fn());
vi.mock("./active-run-owner.js", () => ({ assertActiveRunOwnerState: assertOwner }));

import { updateTicketLabelsForRun } from "./ticket-label-mutation.js";

const db = {} as never;
const owner = {
  subjectKey: "ticket:jira:AIW-101",
  ownerToken: "owner-1",
  runId: "run-1",
};

function tracker(labels: string[], updateLabels = vi.fn()) {
  return {
    fetchTicket: vi.fn().mockResolvedValue({ labels }),
    moveTicket: vi.fn(),
    updateLabels,
  } as unknown as IssueTrackerAdapter;
}

describe("updateTicketLabelsForRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertOwner.mockResolvedValue(undefined);
  });

  it("checks the exact phase owner before applying a normalized delta", async () => {
    const issueTracker = tracker([]);
    await updateTicketLabelsForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "bound",
      changes: { add: [" needs-input ", "needs-input"] },
    });

    expect(assertOwner).toHaveBeenCalledWith(db, owner, "bound");
    expect(issueTracker.updateLabels).toHaveBeenCalledWith("AIW-101", {
      add: ["needs-input"],
    });
  });

  it("does not call Jira when the requested state already holds", async () => {
    const issueTracker = tracker(["needs-input"]);
    await updateTicketLabelsForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "bound",
      changes: { add: ["needs-input"] },
    });
    expect(assertOwner).toHaveBeenCalledOnce();
    expect(issueTracker.updateLabels).not.toHaveBeenCalled();
  });

  it("rejects contradictory changes before any provider work", async () => {
    const issueTracker = tracker([]);
    await expect(updateTicketLabelsForRun({
      db,
      issueTracker,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "bound",
      changes: { add: ["same"], remove: ["same"] },
    })).rejects.toThrow("cannot be added and removed");
    expect(issueTracker.fetchTicket).not.toHaveBeenCalled();
  });
});
