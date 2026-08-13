import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { retireParkedRun } from "./retire-park.js";
import {
  clearClarificationTicketMissing,
  listParkedTicketClarifications,
  markClarificationTicketMissing,
} from "./store.js";

/**
 * How long a park's ticket has to keep reading as absent before the park is
 * retired. Jira answers 404 both for an issue that was deleted and for one the
 * token may no longer view, and the two are indistinguishable from a single
 * reading, so the absence has to outlive a permission blip or a bad response.
 * Held against the incident it fixes: a starved pool lasted over an hour, so
 * costing the recovery a few minutes buys the safety cheaply.
 */
export const TICKET_MISSING_CONFIRMATION_MS = 5 * 60 * 1_000;

/**
 * Blast radius of one pass. A wrong verdict is destructive (it retires a human's
 * open question and cancels a run), so no single pass may act on more than this,
 * whatever the tracker says. Parks beyond it keep their confirmed marker and are
 * retired on later passes.
 */
const MAX_RETIREMENTS_PER_PASS = 3;

export interface DeletedTicketSweepResult {
  /** Parks whose ticket read as absent in this pass. */
  observed: number;
  /** Parks retired, so their concurrency slot is free again. */
  retired: number;
}

/**
 * Retire parks whose ticket no longer exists in the tracker.
 *
 * Nothing else notices a deleted ticket. The asking run stays suspended on a
 * hook nobody can answer (the question lives on a ticket that is gone), its
 * bound claim keeps occupying one of MAX_CONCURRENT_AGENTS slots until the seven
 * day hook expiry, and the dashboard keeps advertising it as input needed. Three
 * of those on a client tenant on 2026-08-13 left the pool with zero free slots
 * while nothing was running, and every newly queued ticket was refused as
 * `at_capacity` for over an hour.
 *
 * Deliberately its own pass rather than a branch inside reconcileRuns: the sets
 * that path works with mix clarification parks with approval parks and
 * recoverable manual dispatches, so a "the ticket is gone" rule wired in there
 * would fire at subjects that have no question at all.
 *
 * Guards, in the order they apply. Each one exists because the action is
 * destructive and the evidence is a single HTTP status:
 *   - no tracker means no verdict. An absent tracker cannot tell "deleted" from
 *     "unreachable", so the pass does nothing (unlike verifyTicketLeftAiColumn,
 *     which treats a missing tracker as departure).
 *   - only an error that names the ticket as absent counts. Every other failure
 *     is "unknown" and leaves the park exactly as it was.
 *   - the absence has to persist for TICKET_MISSING_CONFIRMATION_MS, recorded on
 *     the clarification row because each poll tick is a fresh invocation.
 *   - at most MAX_RETIREMENTS_PER_PASS retirements per pass.
 * A pass where every park reads absent is also the signature of a tracker
 * visibility change rather than of deletions, so it is warned about explicitly;
 * it is not blocked, because the incident this fixes was exactly that shape
 * (three parks, all three tickets genuinely deleted).
 */
export async function retireParksForDeletedTickets(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
  issueTracker?: Pick<IssueTrackerAdapter, "fetchTicket">;
}): Promise<DeletedTicketSweepResult> {
  const { db, runRegistry, issueTracker } = input;
  const result: DeletedTicketSweepResult = { observed: 0, retired: 0 };
  if (!issueTracker) return result;

  const parks = await listParkedTicketClarifications(db);
  if (parks.length === 0) return result;

  const now = Date.now();
  for (const park of parks) {
    const presence = await probeTicket(issueTracker, park.ticketKey);
    if (presence === "unknown") continue;

    if (presence === "present") {
      if (park.ticketMissingSince) {
        await clearClarificationTicketMissing(db, park.runId);
        logger.info(
          { ticketKey: park.ticketKey, runId: park.runId },
          "park_ticket_read_back",
        );
      }
      continue;
    }

    result.observed++;
    if (!park.ticketMissingSince) {
      await markClarificationTicketMissing(db, park.runId, new Date(now));
      logger.info(
        { ticketKey: park.ticketKey, runId: park.runId },
        "park_ticket_missing_first_seen",
      );
      continue;
    }
    if (now - park.ticketMissingSince.getTime() < TICKET_MISSING_CONFIRMATION_MS) {
      continue;
    }
    if (result.retired >= MAX_RETIREMENTS_PER_PASS) {
      logger.warn(
        { ticketKey: park.ticketKey, runId: park.runId },
        "park_retirement_deferred_pass_limit",
      );
      continue;
    }

    const cancellation = await retireParkedRun({
      db,
      runRegistry,
      runId: park.runId,
      cause: { kind: "ticket_deleted", ticketKey: park.ticketKey },
    });
    // Only "unconfirmed" leaves the run untouched, and the marker stays behind
    // it, so the next pass retries. Every other outcome means this park is done
    // with: cancelled by this call, or already terminal on its own.
    if (cancellation.outcome === "unconfirmed") {
      logger.warn(
        { ticketKey: park.ticketKey, runId: park.runId },
        "park_retirement_unconfirmed",
      );
      continue;
    }
    result.retired++;
  }

  if (result.observed >= MAX_RETIREMENTS_PER_PASS && result.observed === parks.length) {
    logger.warn(
      { parks: parks.length, observed: result.observed },
      "park_sweep_all_tickets_absent",
    );
  }
  return result;
}

/**
 * Absence has to be established the same way the answer path establishes it,
 * because that is the reading proven against production: a deleted ticket makes
 * fetchTicket raise IssueTrackerNotFoundError, which is what turns an answer
 * into `ticket_gone` (clarifications/answer-core.ts). Anything else, including a
 * transport failure or a 500, is not evidence of anything.
 */
async function probeTicket(
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket">,
  ticketKey: string,
): Promise<"present" | "absent" | "unknown"> {
  try {
    await issueTracker.fetchTicket(ticketKey);
    return "present";
  } catch (error) {
    if (error instanceof IssueTrackerNotFoundError) return "absent";
    logger.warn(
      { ticketKey, error: (error as Error).message },
      "park_ticket_probe_failed",
    );
    return "unknown";
  }
}
