import { getRun } from "workflow/api";
import { logger } from "./logger.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import { stopTicketSandboxes } from "../sandbox/stop-ticket-sandboxes.js";

/**
 * Cancel a workflow run and unregister it from the registry.
 * Idempotent: safe to call multiple times for the same ticket.
 * Returns true if cancel succeeded, false if it errored (still unregisters).
 *
 * If `issueTracker` and `targetColumn` are provided, also transitions the
 * ticket out of its current column. Without this, the cron sees the ticket
 * still in COLUMN_AI on the next tick and re-dispatches a fresh run.
 */
export async function cancelRun(
  ticketKey: string,
  runId: string,
  runRegistry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  targetColumn?: string,
): Promise<boolean> {
  let cancelled = false;
  try {
    const run = getRun(runId);
    await run.cancel();
    cancelled = true;
  } catch (err) {
    logger.warn(
      { ticketKey, runId, error: (err as Error).message },
      "cancel_run_error",
    );
  }

  // Look up the sandboxId first so the stop path is O(1) instead of a
  // branch-scan across every running sandbox. Best-effort — if this
  // lookup errors or returns null, stopTicketSandboxes falls back to the
  // parallel branch scan.
  const sandboxId = await runRegistry.getSandboxId(ticketKey).catch(() => null);
  await stopTicketSandboxes(ticketKey, sandboxId).catch(() => {});
  await runRegistry.unregister(ticketKey).catch(() => {});

  if (issueTracker && targetColumn) {
    try {
      await issueTracker.moveTicket(ticketKey, targetColumn);
    } catch (err) {
      logger.warn(
        { ticketKey, targetColumn, error: (err as Error).message },
        "cancel_run_move_ticket_failed",
      );
    }
  }

  return cancelled;
}
