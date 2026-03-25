import { getRun } from "workflow/api";
import { isClaimingSentinel, getClaimTimestamp } from "./dispatch.js";
import { cancelRun } from "./cancel-run.js";
import { logger } from "./logger.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STALE_CLAIM_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Reconcile the run registry against current AI-column tickets.
 * - Cleans completed/failed/unreachable runs
 * - Cancels runs for tickets that left the AI column
 * - Skips in-flight claims (CLAIMING_SENTINEL)
 *
 * All operations are idempotent — safe to run concurrently with webhooks.
 */
export async function reconcileRuns(
  aiColumnTickets: Set<string>,
  runRegistry: RunRegistryAdapter,
): Promise<{ cancelled: number; cleaned: number }> {
  const activeRuns = await runRegistry.listAll();
  let cancelled = 0;
  let cleaned = 0;

  for (const { ticketKey, runId } of activeRuns) {
    if (isClaimingSentinel(runId)) {
      if (Date.now() - getClaimTimestamp(runId) > STALE_CLAIM_MS) {
        await runRegistry.unregister(ticketKey);
        logger.warn({ ticketKey, runId }, "reconcile_cleaned_stale_claim");
        cleaned++;
      } else if (!aiColumnTickets.has(ticketKey)) {
        // Ticket left AI column while dispatch is in-flight — clear the claim
        // so the dispatch detects cancellation and aborts the workflow
        await runRegistry.unregister(ticketKey);
        logger.info({ ticketKey, runId }, "reconcile_cancelled_inflight_claim");
        cancelled++;
      }
      continue;
    }

    if (aiColumnTickets.has(ticketKey)) {
      // Ticket still in AI column — clean if run is done
      try {
        const run = getRun(runId);
        const status = await run.status;
        if (TERMINAL_STATUSES.has(status)) {
          await runRegistry.unregister(ticketKey);
          logger.info({ ticketKey, runId, status }, "reconcile_cleaned_done");
          cleaned++;
        }
      } catch {
        await runRegistry.unregister(ticketKey).catch(() => {});
        logger.warn({ ticketKey, runId }, "reconcile_cleaned_unreachable");
        cleaned++;
      }
    } else {
      // Ticket left AI column — cancel the run
      const ok = await cancelRun(ticketKey, runId, runRegistry);
      logger.info({ ticketKey, runId, ok }, "reconcile_cancelled_stale");
      cancelled++;
    }
  }

  return { cancelled, cleaned };
}
