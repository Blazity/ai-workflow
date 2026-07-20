import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
  TicketContent,
} from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import {
  assertActiveRunOwnerState,
  type ActiveRunOwner,
} from "./active-run-owner.js";

export type TicketTransitionOwner = ActiveRunOwner;

/**
 * Move a ticket behind an exact active-owner check. Jira webhook echoes are
 * identified by their actor account id, so this mutation does not need its own
 * database state machine.
 */
export async function moveTicketForRun(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  target: IssueTrackerMoveTarget;
  owner: TicketTransitionOwner;
  requiredOwnerState?: "reserved" | "bound" | "parked" | "cancelling";
}): Promise<void> {
  const state =
    input.requiredOwnerState ?? (input.owner.runId === null ? "reserved" : "bound");
  const current = await input.issueTracker.fetchTicket(input.ticketKey);
  if (ticketMatchesMoveTarget(current, input.target)) {
    await assertActiveRunOwnerState(input.db, input.owner, state);
    return;
  }

  await assertActiveRunOwnerState(input.db, input.owner, state);
  try {
    await input.issueTracker.moveTicket(input.ticketKey, input.target);
  } catch (error) {
    // A provider may accept the transition and lose its response. One live
    // read is enough to turn that ambiguous transport result into success.
    try {
      const afterError = await input.issueTracker.fetchTicket(input.ticketKey);
      if (ticketMatchesMoveTarget(afterError, input.target)) return;
    } catch {
      // Preserve the original mutation error.
    }
    throw error;
  }
}

export function ticketMatchesMoveTarget(
  ticket: Pick<TicketContent, "trackerStatus" | "trackerStatusId">,
  target: IssueTrackerMoveTarget,
): boolean {
  const currentName = ticket.trackerStatus.trim().toLowerCase();
  if (typeof target === "string") return currentName === target.trim().toLowerCase();
  if (target.statusId !== undefined && ticket.trackerStatusId !== undefined) {
    return ticket.trackerStatusId === target.statusId;
  }
  return currentName === target.name.trim().toLowerCase();
}
