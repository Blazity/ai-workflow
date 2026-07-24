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
import { confirmWorkflowStepsDrained } from "./workflow-step-drain.js";

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
  reason?: string,
): Promise<boolean> {
  const subjectKey = ticketSubjectKey("jira", ticketKey);
  const confirmTicketMove = issueTracker && targetColumn
    ? async (owner: { subjectKey: string; ownerToken: string; runId: string | null }) => {
      const [{ getDb }, { moveTicketForRun }] = await Promise.all([
        import("../db/client.js"),
        import("./ticket-transition.js"),
      ]);
      await moveTicketForRun({
        db: getDb(),
        issueTracker,
        ticketKey,
        target: targetColumn,
        owner,
        requiredOwnerState: "cancelling",
      });
    }
    : undefined;
  return (
    await cancelOwnedSubject(
      subjectKey,
      target,
      runRegistry,
      onReleased,
      confirmTicketMove,
      reason,
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
  reason?: string,
): Promise<boolean> {
  return (await cancelOwnedSubject(subjectKey, target, runRegistry, onReleased, undefined, reason)).cancelled;
}

async function cancelOwnedSubject(
  subjectKey: string,
  target: CancelRunTarget,
  runRegistry: RunRegistryAdapter,
  onReleased?: (subjectKey: string) => Promise<void> | void,
  beforeRelease?: (owner: {
    subjectKey: string;
    ownerToken: string;
    runId: string | null;
  }) => Promise<void>,
  reason?: string,
): Promise<{ cancelled: boolean; released: boolean }> {
  let observed: ObservedRunClaim;
  if (typeof target === "string") {
    const entry = await runRegistry.get(subjectKey).catch(() => undefined);
    if (
      entry === undefined ||
      entry === null ||
      !isCancellableRunState(entry.state) ||
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
    const workflowRun = getRun(closed.runId);
    try {
      await workflowRun.cancel();
    } catch (err) {
      let status: string;
      try {
        status = await workflowRun.status;
      } catch (statusError) {
        logger.warn(
          {
            subjectKey,
            runId: closed.runId,
            error: (err as Error).message,
            statusError: (statusError as Error).message,
          },
          "cancel_run_error",
        );
        return { cancelled: false, released: false };
      }
      if (status !== "completed" && status !== "failed" && status !== "cancelled") {
        logger.warn(
          { subjectKey, runId: closed.runId, status, error: (err as Error).message },
          "cancel_run_error",
        );
        return { cancelled: false, released: false };
      }
      logger.info(
        { subjectKey, runId: closed.runId, status },
        "cancel_run_already_terminal",
      );
    }
    await persistCancelReason(subjectKey, closed.runId, reason);
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

  if (closed.runId && !(await confirmWorkflowStepsDrained(subjectKey, closed.runId))) {
    return { cancelled: false, released: false };
  }

  if (
    closed.runId &&
    !(await retirePostDrainContinuations(subjectKey, closed, closed.runId))
  ) {
    return { cancelled: false, released: false };
  }

  if (beforeRelease) {
    if (!(await confirmBeforeRelease(subjectKey, closed, beforeRelease))) {
      return { cancelled: false, released: false };
    }
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

/**
 * Best-effort durable record of why the run was cancelled, so a "blocked" row
 * in the dashboard is never reason-less. Runs after the Workflow cancellation
 * (or the already-terminal confirmation) and must never affect the cancel
 * outcome: any failure is logged and swallowed.
 */
async function persistCancelReason(
  subjectKey: string,
  runId: string,
  reason?: string,
): Promise<void> {
  if (!reason) return;
  try {
    const [{ getDb }, { recordRunStatusReason }] = await Promise.all([
      import("../db/client.js"),
      import("./telemetry/run-telemetry.js"),
    ]);
    await recordRunStatusReason(getDb(), runId, reason);
  } catch (error) {
    logger.warn(
      { subjectKey, runId, error: (error as Error).message },
      "cancel_run_status_reason_unconfirmed",
    );
  }
}

/**
 * A step that was already running when cancellation won can persist a human
 * continuation after the initial tombstone. Once Workflow confirms every step
 * has drained, retire the exact run's questions and undispatched approvals one
 * final time before releasing ownership. No producer can write a later row
 * after this barrier.
 */
async function retirePostDrainContinuations(
  subjectKey: string,
  closed: ActiveRunEntry,
  runId: string,
): Promise<boolean> {
  try {
    const [
      { getDb },
      { tombstoneClarificationCancellation },
      { retireApprovalCancellation },
    ] = await Promise.all([
      import("../db/client.js"),
      import("../clarifications/store.js"),
      import("../approvals/store.js"),
    ]);
    const db = getDb();
    await tombstoneClarificationCancellation(db, {
      subjectKey,
      ownerToken: closed.ownerToken,
      runId,
    });
    if (closed.ticketKey) {
      await retireApprovalCancellation(db, {
        ticketKey: closed.ticketKey,
        runId,
      });
    }
    return true;
  } catch (error) {
    logger.warn(
      { subjectKey, runId, error: (error as Error).message },
      "cancel_run_post_drain_continuation_cleanup_unconfirmed",
    );
    return false;
  }
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
          (isCancellableRunState(entry.state) &&
            entry.runId !== null)
      : isCancellableRunState(entry.state) &&
          entry.runId === observed.runId;
  }
  return (
    tombstone.matched &&
    tombstone.successorOwnerToken !== null &&
    entry.ownerToken === tombstone.successorOwnerToken
  );
}

function isCancellableRunState(state: ActiveRunEntry["state"]): boolean {
  return (
    state === "bound" ||
    state === "parking" ||
    state === "parked" ||
    state === "cancelling"
  );
}

async function confirmBeforeRelease(
  subjectKey: string,
  owner: { subjectKey: string; ownerToken: string; runId: string | null },
  beforeRelease: (owner: {
    subjectKey: string;
    ownerToken: string;
    runId: string | null;
  }) => Promise<void>,
): Promise<boolean> {
  try {
    await beforeRelease(owner);
    return true;
  } catch (error) {
    logger.warn(
      { subjectKey, runId: owner.runId, error: (error as Error).message },
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
