import { getRun } from "workflow/api";
import { isClaimingSentinel, getClaimTimestamp } from "./dispatch.js";
import { cancelRun } from "./cancel-run.js";
import { logger } from "./logger.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STALE_CLAIM_MS = 5 * 60 * 1000;

export async function reconcileRuns(
  aiColumnTickets: Set<string>,
  runRegistry: RunRegistryAdapter,
): Promise<{ cancelled: number; cleaned: number }> {
  const activeRuns = await runRegistry.listAll();
  let cancelled = 0;
  let cleaned = 0;

  for (const { ticketKey, runId } of activeRuns) {
    if (isClaimingSentinel(runId)) {
      const result = await reconcileInflightClaim(
        ticketKey,
        runId,
        aiColumnTickets,
        runRegistry,
      );
      cancelled += result.cancelled;
      cleaned += result.cleaned;
      continue;
    }

    const ticketStillInAiColumn = aiColumnTickets.has(ticketKey);

    if (ticketStillInAiColumn) {
      cleaned += await cleanFinishedRun(ticketKey, runId, runRegistry);
    } else {
      await cancelRun(ticketKey, runId, runRegistry);
      logger.info({ ticketKey, runId }, "reconcile_cancelled_orphaned_run");
      cancelled++;
    }
  }

  return { cancelled, cleaned };
}

async function reconcileInflightClaim(
  ticketKey: string,
  runId: string,
  aiColumnTickets: Set<string>,
  runRegistry: RunRegistryAdapter,
): Promise<{ cancelled: number; cleaned: number }> {
  const claimAge = Date.now() - getClaimTimestamp(runId);
  const claimIsStale = claimAge > STALE_CLAIM_MS;
  const ticketLeftAiColumn = !aiColumnTickets.has(ticketKey);

  if (claimIsStale) {
    await runRegistry.unregister(ticketKey);
    logger.warn({ ticketKey, runId }, "reconcile_cleaned_stale_claim");
    return { cancelled: 0, cleaned: 1 };
  }

  if (ticketLeftAiColumn) {
    await runRegistry.unregister(ticketKey);
    logger.info({ ticketKey, runId }, "reconcile_cancelled_inflight_claim");
    return { cancelled: 1, cleaned: 0 };
  }

  return { cancelled: 0, cleaned: 0 };
}

async function cleanFinishedRun(
  ticketKey: string,
  runId: string,
  runRegistry: RunRegistryAdapter,
): Promise<number> {
  try {
    const run = getRun(runId);
    const status = await run.status;

    if (!TERMINAL_STATUSES.has(status)) return 0;

    await runRegistry.unregister(ticketKey);
    logger.info({ ticketKey, runId, status }, "reconcile_cleaned_finished_run");
    return 1;
  } catch {
    await runRegistry.unregister(ticketKey).catch(() => {});
    logger.warn({ ticketKey, runId }, "reconcile_cleaned_unreachable_run");
    return 1;
  }
}
