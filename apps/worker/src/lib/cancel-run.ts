import { getRun } from "workflow/api";
import { logger } from "./logger.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
} from "../adapters/issue-tracker/types.js";
import { stopSandboxesByIds } from "../sandbox/stop-ticket-sandboxes.js";
import { ticketSubjectKey } from "./subject-key.js";

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
  targetColumn?: IssueTrackerMoveTarget,
  onReleased?: (subjectKey: string) => Promise<void> | void,
): Promise<boolean> {
  const subjectKey = ticketSubjectKey("jira", ticketKey);
  const entry = await runRegistry.get(subjectKey).catch(() => null);
  if (!entry || entry.state !== "bound" || entry.runId !== runId) return false;

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

  const sandboxIds = await runRegistry
    .listSandboxes(subjectKey, entry.ownerToken)
    .catch(() => []);
  await stopSandboxesByIds(sandboxIds).catch(() => {});
  const released = await runRegistry
    .release(subjectKey, entry.ownerToken, runId)
    .catch(() => false);
  if (released && onReleased) await onReleased(subjectKey);

  if (released && issueTracker && targetColumn) {
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
