import type { IssueTrackerMoveTarget } from "../adapters/issue-tracker/types.js";
import type { TicketTransitionOwner } from "../lib/ticket-transition.js";

export async function moveTicketStep(
  ticketKey: string,
  target: IssueTrackerMoveTarget,
  owner: TicketTransitionOwner,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { createAdapters } = await import("../lib/adapters.js");
  const { moveTicketForRun } = await import("../lib/ticket-transition.js");
  await moveTicketForRun({
    db: getDb(),
    issueTracker: createAdapters().issueTracker,
    ticketKey,
    target,
    owner,
  });
}
