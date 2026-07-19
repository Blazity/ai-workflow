import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import { AWAITING_APPROVAL_LABEL, NEEDS_CLARIFICATION_LABEL } from "./labels.js";
import {
  reconcileUnfinishedTicketLabelMutations,
  updateTicketLabelsWithIntent,
} from "./ticket-label-mutation.js";
import {
  moveTicketWhileCancelling,
  reconcileUnfinishedTicketTransitions,
  ticketMatchesMoveTarget,
  type TicketTransitionOwner,
} from "./ticket-transition.js";
import {
  getTicketCancellationFence,
  getTicketMutationVersion,
  listPotentialLateTicketTransitionTargets,
} from "./ticket-transition-intent-store.js";

// Jira's event timestamp and the worker database do not share a transactional
// clock. Include a conservative overlap so a workflow move that lands after
// the human event but before delayed webhook receipt cannot escape the fence.
const PROVIDER_EVENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface TicketCancellationReconciliationResult {
  latestFenceId: number | null;
  hasHumanFence: boolean;
  mutationVersion: number;
  /** The provider confirmed that the ticket no longer exists. */
  ticketMissing?: boolean;
}

/**
 * Runs only after Workflow reports that every already-started step has drained
 * and before the exact cancelling owner is released. A provider transition
 * that finished after the human webhook is compensated only while Jira still
 * shows that exact workflow destination; a later human destination wins.
 */
export async function reconcileTicketCancellationAfterDrain(input: {
  db: Db;
  issueTracker?: IssueTrackerAdapter;
  ticketKey: string;
  owner: TicketTransitionOwner;
  now?: Date;
}): Promise<TicketCancellationReconciliationResult> {
  const { db, ticketKey, owner } = input;
  const fence = await getTicketCancellationFence(db, { ticketKey, ...owner });
  if (!input.issueTracker) {
    if (!fence) {
      return {
        latestFenceId: null,
        hasHumanFence: false,
        mutationVersion: await getTicketMutationVersion(db, owner),
      };
    }
    throw new Error("Ticket cancellation reconciliation requires an issue tracker adapter.");
  }

  const issueTracker = input.issueTracker;
  const transitionSettlement = await reconcileUnfinishedTicketTransitions({
    db,
    issueTracker,
    ticketKey,
    owner,
  });
  if (!transitionSettlement.settled) {
    throw new Error("Ticket provider transition is still in flight.");
  }
  const labelSettlement = await reconcileUnfinishedTicketLabelMutations({
    db,
    issueTracker,
    ticketKey,
    owner,
    now: input.now,
  });
  if (!labelSettlement.settled) {
    throw new Error("Ticket label mutation is still in flight.");
  }
  const potentialLateMoves = fence
    ? await listPotentialLateTicketTransitionTargets(db, {
        ticketKey,
        ...owner,
        finishedAfter: new Date(
          Math.min(
            fence.createdAt.getTime(),
            fence.occurredAt.getTime() - PROVIDER_EVENT_CLOCK_SKEW_MS,
          ),
        ),
      })
    : [];
  if (potentialLateMoves.some(({ providerFinishedAt }) => providerFinishedAt === null)) {
    throw new Error("Ticket provider transition is still in flight.");
  }

  let liveTicket: Awaited<ReturnType<IssueTrackerAdapter["fetchTicket"]>>;
  try {
    liveTicket = await issueTracker.fetchTicket(ticketKey);
  } catch (error) {
    if (
      !(error instanceof IssueTrackerNotFoundError) &&
      getErrorCode(error) !== "NOT_FOUND"
    ) {
      throw error;
    }
    return {
      latestFenceId: fence?.id ?? null,
      hasHumanFence: fence !== null,
      mutationVersion: await getTicketMutationVersion(db, owner),
      ticketMissing: true,
    };
  }
  const shouldRestoreHumanDestination =
    fence !== null &&
    !ticketMatchesMoveTarget(liveTicket, fence.target) &&
    potentialLateMoves.some(({ target }) => ticketMatchesMoveTarget(liveTicket, target));

  if (shouldRestoreHumanDestination && fence) {
    await restoreHumanDestination({
      db,
      issueTracker,
      ticketKey,
      target: fence.target,
      owner,
    });
  }

  if (typeof issueTracker.updateLabels === "function") {
    const labelsToRemove = [NEEDS_CLARIFICATION_LABEL, AWAITING_APPROVAL_LABEL].filter(
      (label) => liveTicket.labels.includes(label),
    );
    if (labelsToRemove.length > 0) {
      // Jira label operations are partial mutations. Unrelated labels added by a
      // human after the workflow started are never replaced by an old snapshot.
      await updateTicketLabelsWithIntent({
        db,
        issueTracker,
        ticketKey,
        owner,
        requiredOwnerState: "cancelling",
        changes: { remove: labelsToRemove },
      });
    }
  }
  return {
    latestFenceId: fence?.id ?? null,
    hasHumanFence: fence !== null,
    mutationVersion: await getTicketMutationVersion(db, owner),
  };
}

async function restoreHumanDestination(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  target: Parameters<IssueTrackerAdapter["moveTicket"]>[1];
  owner: TicketTransitionOwner;
}): Promise<void> {
  await moveTicketWhileCancelling(input);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
