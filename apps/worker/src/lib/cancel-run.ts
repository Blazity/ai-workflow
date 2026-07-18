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
 * Returns true if Workflow cancellation was confirmed. On an API error the
 * owner and its sandboxes remain intact so reconciliation cannot overlap a run
 * that may still be executing.
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
  const outcome = await cancelOwnedSubject(subjectKey, runId, runRegistry, onReleased);
  if (outcome.released && issueTracker && targetColumn) {
    try {
      await issueTracker.moveTicket(ticketKey, targetColumn);
    } catch (err) {
      logger.warn(
        { ticketKey, targetColumn, error: (err as Error).message },
        "cancel_run_move_ticket_failed",
      );
    }
  }
  return outcome.cancelled;
}

/** Operational cancellation for provider-neutral subjects, including
 * ticketless `scope:any` PR/MR runs. */
export async function cancelSubjectRun(
  subjectKey: string,
  runId: string,
  runRegistry: RunRegistryAdapter,
  onReleased?: (subjectKey: string) => Promise<void> | void,
): Promise<boolean> {
  return (await cancelOwnedSubject(subjectKey, runId, runRegistry, onReleased)).cancelled;
}

async function cancelOwnedSubject(
  subjectKey: string,
  runId: string,
  runRegistry: RunRegistryAdapter,
  onReleased?: (subjectKey: string) => Promise<void> | void,
): Promise<{ cancelled: boolean; released: boolean }> {
  const entry = await runRegistry.get(subjectKey).catch(() => null);
  if (!entry || entry.state !== "bound" || entry.runId !== runId) {
    return { cancelled: false, released: false };
  }

  try {
    const run = getRun(runId);
    await run.cancel();
  } catch (err) {
    logger.warn(
      { subjectKey, runId, error: (err as Error).message },
      "cancel_run_error",
    );
    return { cancelled: false, released: false };
  }

  // A clarification continuation is deliberately recoverable when its owner
  // disappears after a crash. Record an explicit cancellation before removing
  // that owner so reconciliation can distinguish the operator action from a
  // recoverable disappearance. DB failure is fail-closed: the cancelled
  // Workflow remains owned until this durable boundary can be retried.
  try {
    const [{ getDb }, { tombstoneClarificationCancellation }] = await Promise.all([
      import("../db/client.js"),
      import("../clarifications/store.js"),
    ]);
    await tombstoneClarificationCancellation(getDb(), {
      subjectKey,
      ownerToken: entry.ownerToken,
      runId,
    });
  } catch (err) {
    logger.warn(
      { subjectKey, runId, error: (err as Error).message },
      "cancel_run_clarification_tombstone_unconfirmed",
    );
    return { cancelled: true, released: false };
  }

  const sandboxIds = await runRegistry
    .listSandboxes(subjectKey, entry.ownerToken)
    .catch(() => null);
  if (sandboxIds === null) {
    logger.warn({ subjectKey, runId }, "cancel_run_sandbox_lookup_unconfirmed");
    return { cancelled: true, released: false };
  }
  try {
    await stopSandboxesByIds(sandboxIds);
  } catch (err) {
    logger.warn(
      { subjectKey, runId, error: (err as Error).message },
      "cancel_run_sandbox_cleanup_unconfirmed",
    );
    return { cancelled: true, released: false };
  }
  const released = await runRegistry
    .release(subjectKey, entry.ownerToken, runId)
    .catch(() => false);
  if (released && onReleased) await onReleased(subjectKey);
  return { cancelled: true, released };
}
