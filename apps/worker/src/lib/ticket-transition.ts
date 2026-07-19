import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
  TicketContent,
} from "../adapters/issue-tracker/types.js";
import { IssueTrackerNotFoundError } from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import { assertActiveRunOwner } from "./active-run-owner.js";
import {
  beginTicketTransitionIntent,
  discardTicketTransitionIntent,
  finishTicketTransitionIntent,
  listUnfinishedTicketTransitions,
  recordStartedParkedTicketTransitionIntent,
  recordStartedTicketReconciliationIntent,
  recordTicketTransitionIntent,
} from "./ticket-transition-intent-store.js";

export interface TicketTransitionOwner {
  subjectKey: string;
  ownerToken: string;
  runId: string | null;
}

export interface TicketTransitionSettlementResult {
  settled: boolean;
  settledIntentIds: number[];
  pendingIntentIds: number[];
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
  if (ticketMatchesMoveTarget(current, target)) return;

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
    await assertActiveRunOwner(db, owner);
  } catch (error) {
    await discardTicketTransitionIntent(db, intentId);
    throw error;
  }

  if (!(await beginTicketTransitionIntent(db, intentId, owner))) {
    await discardTicketTransitionIntent(db, intentId);
    throw new Error("Ticket transition provider start fence is no longer open.");
  }

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
    if (ticketMatchesMoveTarget(afterError, target)) {
      await confirmIntentFinished(db, intentId);
      return;
    }
    // One immediate non-target read cannot disprove an accepted-but-delayed
    // Jira transition. Keep the started boundary unresolved for durable
    // reconciliation; owner release and handoff remain fenced meanwhile.
    throw error;
  }
  await confirmIntentFinished(db, intentId);
}

/** Re-drives clarification ticket parking only after the predecessor has
 * crossed its durable `parked` boundary. Intent start and exact parked-owner
 * proof are atomic, so a concurrent cancellation either closes the owner first
 * (and no provider call happens) or observes the started call for drain-time
 * reconciliation. */
export async function moveTicketWithParkedOwnerIntent(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  target: IssueTrackerMoveTarget;
  owner: TicketTransitionOwner & { runId: string };
}): Promise<void> {
  const { db, issueTracker, ticketKey, target, owner } = input;
  const current = await issueTracker.fetchTicket(ticketKey);
  if (ticketMatchesMoveTarget(current, target)) return;

  const actorAccountId = (await issueTracker.getCurrentUserAccountId?.())?.trim() ?? "";
  if (!actorAccountId) {
    throw new Error("Cannot move Jira ticket without workflow actor account id.");
  }

  const intentId = await recordStartedParkedTicketTransitionIntent(db, {
    ticketKey,
    target,
    actorAccountId,
    ...owner,
  });
  // The initial read happens before the owner-row fence. Another poll may land
  // the same transition while this caller waits for that lock; re-read after
  // the durable start so only one recovery issues the external mutation.
  const afterFence = await issueTracker.fetchTicket(ticketKey);
  if (ticketMatchesMoveTarget(afterFence, target)) {
    await confirmIntentFinished(db, intentId);
    return;
  }
  try {
    await issueTracker.moveTicket(ticketKey, target);
  } catch (error) {
    let afterError: Pick<TicketContent, "trackerStatus" | "trackerStatusId">;
    try {
      afterError = await issueTracker.fetchTicket(ticketKey);
    } catch {
      // Preserve the original provider error and its started intent. A later
      // poll settles positive completion proof or waits through the ambiguity
      // window before re-driving under the same exact parked owner.
      throw error;
    }
    if (ticketMatchesMoveTarget(afterError, target)) {
      await confirmIntentFinished(db, intentId);
      return;
    }
    throw error;
  }
  await confirmIntentFinished(db, intentId);
}

/** Reconciles a provider boundary whose HTTP result or finish write was lost.
 * Observing the intended live Jira status is positive completion proof. A
 * nonmatching status is never negative proof that an accepted Jira transition
 * cannot still land, regardless of retention expiry. The exact owner therefore
 * stays closed to release and handoff until the target, matching provider echo,
 * provider success, or missing ticket supplies positive terminal evidence. This
 * works for reserved, bound, parking, parked, and cancelling owners because the
 * identity, not the owner state, scopes intents. */
export async function reconcileUnfinishedTicketTransitions(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  owner: TicketTransitionOwner;
}): Promise<TicketTransitionSettlementResult> {
  const intents = await listUnfinishedTicketTransitions(input.db, {
    ticketKey: input.ticketKey,
    ...input.owner,
  });
  if (intents.length === 0) {
    return { settled: true, settledIntentIds: [], pendingIntentIds: [] };
  }

  let liveTicket: TicketContent;
  try {
    liveTicket = await input.issueTracker.fetchTicket(input.ticketKey);
  } catch (error) {
    if (
      !(error instanceof IssueTrackerNotFoundError) &&
      getErrorCode(error) !== "NOT_FOUND"
    ) {
      throw error;
    }
    const settledIntentIds: number[] = [];
    for (const intent of intents) {
      if (!(await finishTicketTransitionIntent(input.db, intent.id))) {
        throw new Error(`Ticket transition intent ${intent.id} could not be settled.`);
      }
      settledIntentIds.push(intent.id);
    }
    return { settled: true, settledIntentIds, pendingIntentIds: [] };
  }
  const settledIntentIds: number[] = [];
  const pendingIntentIds: number[] = [];
  for (const intent of intents) {
    const targetObserved = ticketMatchesMoveTarget(liveTicket, intent.target);
    if (!targetObserved) {
      pendingIntentIds.push(intent.id);
      continue;
    }
    if (!(await finishTicketTransitionIntent(input.db, intent.id))) {
      throw new Error(`Ticket transition intent ${intent.id} could not be settled.`);
    }
    settledIntentIds.push(intent.id);
  }
  return {
    settled: pendingIntentIds.length === 0,
    settledIntentIds,
    pendingIntentIds,
  };
}

/** Executes a ticket transition after an owner is already closed for
 * cancellation. Its started intent participates in the same in-flight count
 * and mutation-version CAS as ordinary workflow moves. */
export async function moveTicketWhileCancelling(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  target: IssueTrackerMoveTarget;
  owner: TicketTransitionOwner;
}): Promise<void> {
  const current = await input.issueTracker.fetchTicket(input.ticketKey);
  if (ticketMatchesMoveTarget(current, input.target)) return;
  const actorAccountId =
    (await input.issueTracker.getCurrentUserAccountId?.())?.trim() ?? "";
  if (!actorAccountId) {
    throw new Error("Cannot reconcile Jira ticket without workflow actor account id.");
  }
  const intentId = await recordStartedTicketReconciliationIntent(input.db, {
    ticketKey: input.ticketKey,
    target: input.target,
    actorAccountId,
    ...input.owner,
  });

  try {
    await input.issueTracker.moveTicket(input.ticketKey, input.target);
  } catch (error) {
    let afterError: Pick<TicketContent, "trackerStatus" | "trackerStatusId">;
    try {
      afterError = await input.issueTracker.fetchTicket(input.ticketKey);
    } catch {
      throw error;
    }
    if (!ticketMatchesMoveTarget(afterError, input.target)) {
      throw error;
    }
  }
  await confirmIntentFinished(input.db, intentId);
}

async function confirmIntentFinished(db: Db, intentId: number): Promise<void> {
  if (!(await finishTicketTransitionIntent(db, intentId))) {
    throw new Error("Ticket transition provider completion could not be recorded.");
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

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
