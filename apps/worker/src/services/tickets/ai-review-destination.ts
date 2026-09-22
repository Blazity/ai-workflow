import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
} from "../../adapters/issue-tracker/types.js";
import { logger } from "../../infra/logger.js";

/**
 * The destination a run's own success finalization moves its ticket to. The
 * provider matches COLUMN_AI_REVIEW against transition names as well as status
 * names, so the configured value legitimately names either one.
 */
export function aiReviewMoveTarget(
  aiReviewColumn: string,
  aiReviewTransitionId?: string,
): IssueTrackerMoveTarget {
  return aiReviewTransitionId
    ? { name: aiReviewColumn, transitionId: aiReviewTransitionId }
    : aiReviewColumn;
}

/**
 * One cached destination per resolution, keyed by EVERYTHING the resolution
 * depends on: which tracker answered, the normalized column name, and the
 * transition id it was resolved with, absence included.
 *
 * The key used to be the column name alone, which was safe while both the
 * transition id and the tracker itself came from environment variables and
 * could not change under a running process. Since S12 both come from a
 * connection an admin can edit while the worker is warm, and this cache lives
 * for the life of the process:
 *
 * - Repoint Jira at another site and every status id in here belongs to the
 *   old instance. The reconciler then compares a live status id against one
 *   that can never match, reads a ticket sitting in AI Review as a ticket that
 *   left the AI column, and cancels a healthy run with "Orphaned run cancelled
 *   by reconciler" in front of whoever is watching it.
 * - Resolve once without the transition id and a name-only key would serve
 *   that answer forever, which is the same wrong cancellation by a slower
 *   route.
 *
 * `resetAiReviewDestinationCache` is not the answer to either: nothing calls
 * it outside tests, and a key that covers what the value depends on needs
 * nobody to remember to call anything.
 */
const resolvedReviewStatusIds = new Map<string, string>();

function reviewDestinationCacheKey(
  trackerIdentity: string,
  aiReviewColumn: string,
  aiReviewTransitionId: string | undefined,
): string {
  return [
    trackerIdentity,
    aiReviewColumn.trim().toLowerCase(),
    aiReviewTransitionId ?? "",
  ].join("\u0000");
}

export function resetAiReviewDestinationCache(): void {
  resolvedReviewStatusIds.clear();
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
  aiReviewColumn: string;
  /** Which tracker these answers come from, as an opaque string the caller
   *  builds from the connection it already resolved. Compared, never parsed.
   *  It exists so that nothing cached here survives an admin repointing the
   *  connection; the caller passes it rather than this module reading the
   *  connection a second way. */
  trackerIdentity: string;
  /** The transition the board needs to reach that column, when it has one.
   *  Part of the tracker's wiring, so the caller passes what it already read
   *  rather than this module reading it a second way. */
  aiReviewTransitionId?: string;
}): Promise<boolean> {
  const configured = input.aiReviewColumn.trim().toLowerCase();
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
    input.trackerIdentity,
    input.aiReviewColumn,
    input.aiReviewTransitionId,
  );
  return reviewStatusId !== null && reviewStatusId === statusId;
}

async function resolveReviewStatusId(
  issueTracker: IssueTrackerAdapter,
  ticketKey: string,
  trackerIdentity: string,
  aiReviewColumn: string,
  aiReviewTransitionId: string | undefined,
): Promise<string | null> {
  const cacheKey = reviewDestinationCacheKey(
    trackerIdentity,
    aiReviewColumn,
    aiReviewTransitionId,
  );
  const cached = resolvedReviewStatusIds.get(cacheKey);
  if (cached !== undefined) return cached;
  if (!issueTracker.resolveMoveTargetStatus) return null;
  try {
    const destination = await issueTracker.resolveMoveTargetStatus(
      ticketKey,
      aiReviewMoveTarget(aiReviewColumn, aiReviewTransitionId),
    );
    if (!destination) return null;
    resolvedReviewStatusIds.set(cacheKey, destination.id);
    logger.info(
      {
        configured: aiReviewColumn,
        statusId: destination.id,
        statusName: destination.name,
      },
      "ai_review_destination_resolved",
    );
    return destination.id;
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
