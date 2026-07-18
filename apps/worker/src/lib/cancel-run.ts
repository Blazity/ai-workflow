import { getRun } from "workflow/api";
import { logger } from "./logger.js";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
} from "../adapters/run-registry/types.js";
import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
} from "../adapters/issue-tracker/types.js";
import { stopSandboxesByIds } from "../sandbox/stop-ticket-sandboxes.js";
import { ticketSubjectKey } from "./subject-key.js";

/** Claim identity observed by a route before it delegates cancellation. Keeping
 * the owner as well as the stage lets cancellation follow an in-flight
 * reserved-to-bound promotion without ever targeting a replacement owner. */
export interface ObservedRunClaim {
  ownerToken: string;
  runId: string | null;
}

export type CancelRunTarget = string | ObservedRunClaim;

/**
 * Cancel a workflow run and unregister it from the registry.
 * Idempotent: safe to call multiple times for the same ticket.
 * Returns true only after durable clarification retirement (when applicable),
 * Workflow cancellation, sandbox cleanup, and exact claim release are all
 * confirmed. A false result retains the current owner for a safe retry.
 *
 * If `issueTracker` and `targetColumn` are provided, also transitions the
 * ticket out of its current column. Without this, the cron sees the ticket
 * still in COLUMN_AI on the next tick and re-dispatches a fresh run.
 */
export async function cancelRun(
  ticketKey: string,
  target: CancelRunTarget,
  runRegistry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  targetColumn?: IssueTrackerMoveTarget,
  onReleased?: (subjectKey: string) => Promise<void> | void,
): Promise<boolean> {
  const subjectKey = ticketSubjectKey("jira", ticketKey);
  const confirmTicketMove = issueTracker && targetColumn
    ? async () => {
      await issueTracker.moveTicket(ticketKey, targetColumn);
    }
    : undefined;
  return (
    await cancelOwnedSubject(
      subjectKey,
      target,
      runRegistry,
      onReleased,
      confirmTicketMove,
    )
  ).cancelled;
}

/** Operational cancellation for provider-neutral subjects, including
 * ticketless `scope:any` PR/MR runs. */
export async function cancelSubjectRun(
  subjectKey: string,
  target: CancelRunTarget,
  runRegistry: RunRegistryAdapter,
  onReleased?: (subjectKey: string) => Promise<void> | void,
): Promise<boolean> {
  return (await cancelOwnedSubject(subjectKey, target, runRegistry, onReleased)).cancelled;
}

async function cancelOwnedSubject(
  subjectKey: string,
  target: CancelRunTarget,
  runRegistry: RunRegistryAdapter,
  onReleased?: (subjectKey: string) => Promise<void> | void,
  beforeRelease?: () => Promise<void>,
): Promise<{ cancelled: boolean; released: boolean }> {
  let observed: ObservedRunClaim;
  if (typeof target === "string") {
    const entry = await runRegistry.get(subjectKey).catch(() => undefined);
    if (
      entry === undefined ||
      entry === null ||
      (entry.state !== "bound" && entry.state !== "cancelling") ||
      entry.runId !== target
    ) {
      return { cancelled: false, released: false };
    }
    observed = { ownerToken: entry.ownerToken, runId: target };
  } else {
    observed = target;
  }

  // Persist the operator intent before touching Workflow or the active claim.
  // This closes both answer races: pending->answered cannot proceed after the
  // tombstone, and an answer that already minted a successor token cannot be
  // recreated by reconciliation while cancellation follows the handoff.
  let tombstone: { matched: boolean; successorOwnerToken: string | null };
  try {
    const [{ getDb }, { tombstoneClarificationCancellation }] = await Promise.all([
      import("../db/client.js"),
      import("../clarifications/store.js"),
    ]);
    tombstone = await tombstoneClarificationCancellation(getDb(), {
      subjectKey,
      ownerToken: observed.ownerToken,
      runId: observed.runId,
    });
  } catch (err) {
    logger.warn(
      { subjectKey, runId: observed.runId, error: (err as Error).message },
      "cancel_run_clarification_tombstone_unconfirmed",
    );
    return { cancelled: false, released: false };
  }

  const afterTombstone = await runRegistry.get(subjectKey).catch(() => undefined);
  if (afterTombstone === undefined) {
    return { cancelled: false, released: false };
  }
  if (afterTombstone === null) {
    // Natural completion may have released the claim after the route observed
    // it. Without an exact cancelling marker this caller cannot distinguish
    // that from its own work, so it must not move the ticket or report success.
    return { cancelled: false, released: false };
  }

  // Closing is the resource-registration barrier. beginCancellation updates
  // the same owner row locked by registerSandbox's INSERT-SELECT, so once it
  // succeeds every previously successful child is enumerable and every later
  // externally-created child loses registration and is stopped by its creator.
  let current: ActiveRunEntry = afterTombstone;
  let closed: ActiveRunEntry | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!belongsToCancellation(current, observed, tombstone)) {
      return { cancelled: false, released: false };
    }
    const began = await runRegistry
      .beginCancellation(subjectKey, current.ownerToken, current.runId)
      .catch(() => false);
    if (began) {
      closed = { ...current, state: "cancelling" };
      break;
    }
    const refreshed = await runRegistry.get(subjectKey).catch(() => undefined);
    if (refreshed === undefined) {
      return { cancelled: false, released: false };
    }
    if (refreshed === null) {
      return { cancelled: false, released: false };
    }
    current = refreshed;
  }
  if (!closed) return { cancelled: false, released: false };

  if (closed.runId) {
    try {
      await getRun(closed.runId).cancel();
    } catch (err) {
      logger.warn(
        { subjectKey, runId: closed.runId, error: (err as Error).message },
        "cancel_run_error",
      );
      return { cancelled: false, released: false };
    }
  }

  const sandboxIds = await runRegistry
    .listSandboxes(subjectKey, closed.ownerToken)
    .catch(() => null);
  if (sandboxIds === null) {
    logger.warn(
      { subjectKey, runId: closed.runId },
      "cancel_run_sandbox_lookup_unconfirmed",
    );
    return { cancelled: false, released: false };
  }
  try {
    await stopSandboxesByIds(sandboxIds);
  } catch (err) {
    logger.warn(
      { subjectKey, runId: closed.runId, error: (err as Error).message },
      "cancel_run_sandbox_cleanup_unconfirmed",
    );
    return { cancelled: false, released: false };
  }

  if (!(await confirmBeforeRelease(subjectKey, closed.runId, beforeRelease))) {
    return { cancelled: false, released: false };
  }

  const released = await runRegistry
    .releaseCancellation(subjectKey, closed.ownerToken, closed.runId)
    .catch(() => false);
  if (!released) {
    const refreshed = await runRegistry.get(subjectKey).catch(() => undefined);
    if (refreshed !== null) return { cancelled: false, released: false };
  }
  await notifyReleased(subjectKey, onReleased);
  return { cancelled: true, released: true };
}

function belongsToCancellation(
  entry: ActiveRunEntry,
  observed: ObservedRunClaim,
  tombstone: { matched: boolean; successorOwnerToken: string | null },
): boolean {
  if (entry.ownerToken === observed.ownerToken) {
    // An observed reservation can only move forward to a bound run under that
    // same owner. An observed bound run must retain its exact Workflow id.
    return observed.runId === null
      ? entry.runId === null ||
          ((entry.state === "bound" || entry.state === "cancelling") &&
            entry.runId !== null)
      : (entry.state === "bound" || entry.state === "cancelling") &&
          entry.runId === observed.runId;
  }
  return (
    tombstone.matched &&
    tombstone.successorOwnerToken !== null &&
    entry.ownerToken === tombstone.successorOwnerToken
  );
}

async function confirmBeforeRelease(
  subjectKey: string,
  runId: string | null,
  beforeRelease?: () => Promise<void>,
): Promise<boolean> {
  if (!beforeRelease) return true;
  try {
    await beforeRelease();
    return true;
  } catch (error) {
    logger.warn(
      { subjectKey, runId, error: (error as Error).message },
      "cancel_run_ticket_move_unconfirmed",
    );
    return false;
  }
}

async function notifyReleased(
  subjectKey: string,
  onReleased?: (subjectKey: string) => Promise<void> | void,
): Promise<void> {
  if (!onReleased) return;
  try {
    await onReleased(subjectKey);
  } catch (error) {
    logger.warn(
      { subjectKey, error: (error as Error).message },
      "cancel_run_post_release_callback_failed",
    );
  }
}
