import { env } from "../../env.js";
import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
} from "../adapters/issue-tracker/types.js";
import { logger } from "./logger.js";

/**
 * The destination a run's own success finalization moves its ticket to. The
 * provider matches COLUMN_AI_REVIEW against transition names as well as status
 * names, so the configured value legitimately names either one.
 */
export function aiReviewMoveTarget(): IssueTrackerMoveTarget {
  return env.JIRA_AI_REVIEW_TRANSITION_ID
    ? { name: env.COLUMN_AI_REVIEW, transitionId: env.JIRA_AI_REVIEW_TRANSITION_ID }
    : env.COLUMN_AI_REVIEW;
}

/**
 * Resolved at most once per process: the answer is project workflow
 * configuration, identical for every ticket, so it is not per-run state.
 */
let resolvedReviewStatusId: string | null = null;

export function resetAiReviewDestinationCache(): void {
  resolvedReviewStatusId = null;
}

/**
 * Whether the status a ticket now sits in IS the review destination, which is
 * the run's own success path and therefore never an abort.
 *
 * Comparing display names is not sufficient. COLUMN_AI_REVIEW may name the
 * TRANSITION ("REVIEW") while the status it leads to carries a different,
 * often localized name ("Weryfikacja"), and a name comparison then misses on
 * every such project: the run's own completion gesture reads as "ticket left
 * the AI column" and a run that is still publishing gets cancelled. So fall
 * through to an identity comparison against the transition's resolved
 * destination status id.
 *
 * Costs one provider call, taken only when the free name comparison misses and
 * only once per process. A target that does not resolve (its transition is not
 * offered from where the ticket sits now) leaves the name comparison as the
 * answer, so this can only spare runs the previous check would have cancelled,
 * never the reverse.
 */
export async function isAiReviewDestination(input: {
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  statusName: string | null;
  statusId: string | null;
}): Promise<boolean> {
  const configured = env.COLUMN_AI_REVIEW.trim().toLowerCase();
  if (
    input.statusName !== null &&
    input.statusName.trim().toLowerCase() === configured
  ) {
    return true;
  }
  const statusId = input.statusId?.trim();
  if (!statusId) return false;
  const reviewStatusId = await resolveReviewStatusId(
    input.issueTracker,
    input.ticketKey,
  );
  return reviewStatusId !== null && reviewStatusId === statusId;
}

async function resolveReviewStatusId(
  issueTracker: IssueTrackerAdapter,
  ticketKey: string,
): Promise<string | null> {
  if (resolvedReviewStatusId !== null) return resolvedReviewStatusId;
  if (!issueTracker.resolveMoveTargetStatus) return null;
  try {
    const destination = await issueTracker.resolveMoveTargetStatus(
      ticketKey,
      aiReviewMoveTarget(),
    );
    if (!destination) return null;
    resolvedReviewStatusId = destination.id;
    logger.info(
      {
        configured: env.COLUMN_AI_REVIEW,
        statusId: destination.id,
        statusName: destination.name,
      },
      "ai_review_destination_resolved",
    );
    return resolvedReviewStatusId;
  } catch (error) {
    // Never fail the caller: an unresolved destination just leaves the name
    // comparison as the answer.
    logger.warn(
      { ticketKey, error: (error as Error).message },
      "ai_review_destination_resolution_failed",
    );
    return null;
  }
}
