import type { IssueTrackerMoveTarget } from "../../adapters/issue-tracker/types.js";
import type { TicketTransitionOwner } from "../../services/tickets/ticket-transition.js";

export async function moveTicketStep(
  ticketKey: string,
  target: IssueTrackerMoveTarget,
  owner: TicketTransitionOwner,
): Promise<void> {
  "use step";
  const { createAdapters } = await import("../../services/vcs/adapters.js");
  const { moveConnectedTicketForRun } = await import("../../services/tickets/ticket-transition.js");
  await moveConnectedTicketForRun({
    issueTracker: createAdapters().issueTracker,
    ticketKey,
    target,
    owner,
  });
}
