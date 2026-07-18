import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
  TicketContent,
} from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import {
  discardTicketTransitionIntent,
  recordTicketTransitionIntent,
} from "./ticket-transition-intent-store.js";

export interface TicketTransitionOwner {
  subjectKey: string;
  ownerToken: string;
  runId: string | null;
}

export async function moveTicketWithIntent(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  target: IssueTrackerMoveTarget;
  owner: TicketTransitionOwner;
}): Promise<void> {
  const { db, issueTracker, ticketKey, target, owner } = input;
  const current = await issueTracker.fetchTicket(ticketKey);
  if (ticketAlreadyAtTarget(current, target)) return;

  const actorAccountId = (await issueTracker.getCurrentUserAccountId?.())?.trim() ?? "";
  if (!actorAccountId) {
    throw new Error("Cannot move Jira ticket without workflow actor account id.");
  }

  const intentId = await recordTicketTransitionIntent(db, {
    ticketKey,
    target,
    actorAccountId,
    ...owner,
  });

  try {
    await issueTracker.moveTicket(ticketKey, target);
  } catch (error) {
    let afterError: Pick<TicketContent, "trackerStatus" | "trackerStatusId">;
    try {
      afterError = await issueTracker.fetchTicket(ticketKey);
    } catch {
      // The original move error is the useful failure. Its intent remains
      // available because the provider may still have accepted the request.
      throw error;
    }
    if (ticketAlreadyAtTarget(afterError, target)) return;
    await discardTicketTransitionIntent(db, intentId);
    throw error;
  }
}

function ticketAlreadyAtTarget(
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
