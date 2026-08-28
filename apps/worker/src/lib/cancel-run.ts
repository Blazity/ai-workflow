import { getRun } from "workflow/api";
import { logger } from "./logger.js";
import type { Db } from "../db/client.js";
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
 * Result of a cancellation attempt. `alreadyTerminal` distinguishes a run
 * that was genuinely still in flight and got cancelled by this call from one
 * that had already reached a terminal Workflow status before this call
 * observed it: Workflow's `cancel()` throws in that case, and the outcome is
 * confirmed only by re-reading `status`. Callers that notify operators (e.g.
 * Slack "canceled" messages) must treat the two differently, since the
 * already-terminal case is a release of bookkeeping for a run that failed or
 * completed on its own, not a fresh cancellation.
 *
 * `tornDown` reports the narrower fact that the Workflow run will not advance
 * any further: `cancel()` resolved, or the status re-read confirmed it was
 * already terminal. It does NOT mean the run is quiet yet: a step handler that
 * was already executing keeps running to its end (that is what the step drain
 * waits for), so a side effect can still land after this is true.
 * It stays true on the returns that follow, where `cancelled`
 * is false because a post-teardown bookkeeping step (sandbox cleanup, step
 * drain, continuation retirement, ticket move, claim release) could not be
 * confirmed this attempt. The two must be reported differently: `cancelled`
 * false alone reads as "nothing happened, retry", but a retry cannot un-cancel a
 * dead run, so telling an operator to try again is a lie, and any caller that
 * only settles ledgers on a confirmed cancel would silently skip them. Only
 * meaningful for a claim that carried a run id: a claim with a null runId never
 * touched Workflow and never sets it.
 */
export interface CancelRunResult {
  cancelled: boolean;
  released: boolean;
  alreadyTerminal?: boolean;
  tornDown?: boolean;
}

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
  return (
    await cancelRunDetailed(
      ticketKey,
      target,
      runRegistry,
      issueTracker,
      targetColumn,
      onReleased,
      reason,
    )
  ).cancelled;
}

/**
 * Same as {@link cancelRun}, but also reports whether the run was already
 * terminal when this call observed it, so a caller (the reconciler) can skip
 * re-notifying operators about a run that already failed or completed on its
 * own.
 */
export async function cancelRunDetailed(
  ticketKey: string,
  target: CancelRunTarget,
  runRegistry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  targetColumn?: IssueTrackerMoveTarget,
  onReleased?: (subjectKey: string) => Promise<void> | void,
  reason?: string,
): Promise<CancelRunResult> {
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
  return cancelOwnedSubject(
    subjectKey,
    target,
    runRegistry,
    onReleased,
    confirmTicketMove,
    reason,
  );
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
  return (
    await cancelSubjectRunDetailed(subjectKey, target, runRegistry, onReleased, reason)
  ).cancelled;
}

/** Same as {@link cancelSubjectRun}, but also reports `alreadyTerminal` (see
 * {@link cancelRunDetailed}). */
export async function cancelSubjectRunDetailed(
  subjectKey: string,
  target: CancelRunTarget,
  runRegistry: RunRegistryAdapter,
  onReleased?: (subjectKey: string) => Promise<void> | void,
  reason?: string,
): Promise<CancelRunResult> {
  return cancelOwnedSubject(subjectKey, target, runRegistry, onReleased, undefined, reason);
}

/**
 * Outcome of an operator cancel-by-id. Distinguishes the four states it can
 * reach so a route (or Slack surface) reports each honestly:
 *   - "cancelled": a live run was found and torn down, and its status settled as
 *     "blocked" with the operator reason. Usually its subject is released too so
 *     a schedule/webhook blocked behind it resumes; when only the teardown could
 *     be confirmed, the dying run's own finally releases the claim instead.
 *   - "already_terminal": the run had already reached a terminal outcome, either
 *     Workflow reported it terminal while the claim still lingered, or the run
 *     had already left active_runs. No status is written; `status` carries the
 *     recorded outcome when known.
 *   - "unconfirmed": a live run was found but cancellation never began, so the
 *     Workflow run was never touched and the claim is retained. This is the only
 *     state where a retry is the right advice: once the run is torn down it
 *     cannot be un-cancelled, and that case reports "cancelled" instead.
 *   - "not_found": neither a live claim nor a workflow_runs row carries the id.
 * `subjectKey` is set whenever a live claim was located.
 */
export interface CancelRunByIdResult {
  outcome: "cancelled" | "already_terminal" | "not_found" | "unconfirmed";
  status?: string;
  subjectKey?: string;
}

/**
 * Dependencies a cancel-by-id needs beyond the run id. Kept minimal on purpose:
 * cancelSubjectRunDetailed only requires the registry, and the actor label is
 * folded into the durable "cancelled by <actor>" reason written on the run.
 */
export interface CancelRunByIdDeps {
  actorLabel: string;
  runRegistry: RunRegistryAdapter;
  issueTracker?: IssueTrackerAdapter;
}

/**
 * Operator cancellation addressed by run id instead of ticket key, so any
 * in-flight run can be stopped, including a ticketless webhook or schedule run
 * that no ticket-column cancel path can reach. Reuses cancelSubjectRunDetailed
 * for the real work (Workflow cancel, sandbox cleanup, exact claim release), then
 * settles the run's own status synchronously as "blocked" via
 * markRunBlockedByOperator.
 *
 * The reverse lookup is two-stage on purpose. A freshly bound run exists in
 * active_runs before its workflow_runs row is written, so a single workflow_runs
 * lookup would 404 it: active_runs is consulted first (live -> cancel) and
 * workflow_runs only as the terminal fallback (already left the registry ->
 * no-op report). Absent from both -> the run id is unknown.
 */
export async function cancelRunById(
  db: Db,
  runId: string,
  opts: CancelRunByIdDeps,
): Promise<CancelRunByIdResult> {
  const { actorLabel, runRegistry } = opts;
  const { findLiveRunClaimByRunId, findRunOutcomeByRunId } = await import(
    "../db/queries/runs-read.js"
  );

  const claim = await findLiveRunClaimByRunId(db, runId);
  if (claim) {
    const reason = `cancelled by ${actorLabel}`;
    if (claim.kind === "manual_ticket" && (!claim.ticketKey || !opts.issueTracker)) {
      logger.warn(
        { subjectKey: claim.subjectKey, runId },
        "cancel_manual_ticket_withdrawal_unavailable",
      );
      return { outcome: "unconfirmed", subjectKey: claim.subjectKey };
    }
    const result = claim.kind === "manual_ticket"
      ? await cancelOwnedSubject(
          claim.subjectKey,
          { ownerToken: claim.ownerToken, runId },
          runRegistry,
          undefined,
          async (owner) => {
            const [{ env }, { withdrawTicketFromAiForRun }] = await Promise.all([
              import("../../env.js"),
              import("./ticket-transition.js"),
            ]);
            await withdrawTicketFromAiForRun({
              db,
              issueTracker: opts.issueTracker!,
              ticketKey: claim.ticketKey!,
              aiColumn: env.COLUMN_AI,
              target: env.JIRA_BACKLOG_TRANSITION_ID
                ? {
                    name: env.COLUMN_BACKLOG,
                    transitionId: env.JIRA_BACKLOG_TRANSITION_ID,
                  }
                : env.COLUMN_BACKLOG,
              owner,
              requiredOwnerState: "cancelling",
            });
          },
          reason,
        )
      : await cancelSubjectRunDetailed(
          claim.subjectKey,
          { ownerToken: claim.ownerToken, runId },
          runRegistry,
          undefined,
          reason,
        );
    // alreadyTerminal implies cancelled, so it must be checked first: the run
    // reached a terminal Workflow status on its own and keeps that outcome, so
    // no status is written (only the lingering claim was released).
    if (result.alreadyTerminal) {
      const outcome = await findRunOutcomeByRunId(db, runId);
      return {
        outcome: "already_terminal",
        subjectKey: claim.subjectKey,
        status: outcome?.status ?? undefined,
      };
    }
    if (result.cancelled || result.tornDown) {
      // tornDown without cancelled is a run whose teardown landed but whose
      // post-cancel bookkeeping stayed unconfirmed. It reports identically:
      // "unconfirmed" would tell the operator to retry an irreversible action
      // and, worse, skip every ledger the caller settles on "cancelled" (the
      // schedule occurrence would stay "started"), which is the production bug
      // this branch exists to fix.
      //
      // The status write itself is safe ahead of the drain: no writer can put
      // "running" back over "blocked" (markRunResumed, the only writer of
      // "running", is guarded on "awaiting"), so a cancelled run cannot read as
      // in flight. Best-effort like persistCancelReason, because the teardown
      // already landed and a failed settle must never turn it into a 500.
      //
      // Known trade, deliberately taken: cancelling during the run's own
      // finalization step means recordRunUsage (the one unguarded status
      // writer) can still overwrite this settle with the run's real outcome,
      // and the cron will NOT undo that because upsertRunSnapshots freezes on a
      // terminal status. The row then reads success while the caller already
      // stamped the occurrence "run_cancelled". That mislabel is audit-only
      // (nothing dispatches off the occurrence outcome) and it is the price of
      // not leaving every mid-step cancel unsettled, which is strictly worse.
      //
      // The claim is released here only on the confirmed path. A tornDown-only
      // cancel leaves the claim in "cancelling"; reconcileRuns picks that state
      // up on the one-minute poll cron and converges it through
      // retryCancellingClaim, which is what actually releases it.
      const { markRunBlockedByOperator } = await import(
        "./telemetry/run-telemetry.js"
      );
      try {
        await markRunBlockedByOperator(db, runId, reason);
      } catch (error) {
        logger.warn(
          {
            subjectKey: claim.subjectKey,
            runId,
            error: (error as Error).message,
          },
          "cancel_run_operator_status_unconfirmed",
        );
      }
      return { outcome: "cancelled", subjectKey: claim.subjectKey };
    }
    // A live run cancellation that never began: Workflow was never touched and
    // the claim is retained, so report unconfirmed and let the caller retry.
    return { outcome: "unconfirmed", subjectKey: claim.subjectKey };
  }

  // Not live: the run has already left active_runs (terminal) or never existed.
  const outcome = await findRunOutcomeByRunId(db, runId);
  if (outcome) {
    return { outcome: "already_terminal", status: outcome.status ?? undefined };
  }
  return { outcome: "not_found" };
}

/**
 * A confirmed cancel plus the one piece of bookkeeping that does not belong to any
 * single caller: the schedule ledger. `scheduleOccurrenceSettled` is null unless a
 * schedule run was actually cancelled, so a ticket run's reply does not claim
 * anything about a ledger it has no row in.
 */
export interface CancelRunForOperatorResult extends CancelRunByIdResult {
  scheduleOccurrenceSettled: boolean | null;
}

/**
 * What an operator cancel IS, for every surface that offers one: cancelRunById plus
 * the schedule-occurrence settle.
 *
 * The settle lived in the dashboard route for one caller's lifetime, and that is
 * precisely the shape of the production bug the tornDown branch above exists to fix:
 * a run torn down while its occurrence stayed "started". Reporting "cancelled" while
 * skipping the ledger produces the same end state from the other direction, so a
 * second caller reaching for the core alone would reintroduce it. Hence one function
 * both callers use rather than a comment asking the next one to remember.
 *
 * Best effort by construction: the run is already torn down and its subject released
 * by the time this runs, so neither a no-op nor a failed settle may turn a confirmed
 * cancel into an error. Both are logged under the same event the route logged them
 * under, so existing alerting keeps working.
 */
export async function cancelRunForOperator(
  db: Db,
  runId: string,
  opts: CancelRunByIdDeps,
): Promise<CancelRunForOperatorResult> {
  const result = await cancelRunById(db, runId, opts);
  if (result.outcome !== "cancelled") {
    return { ...result, scheduleOccurrenceSettled: null };
  }

  const isScheduleRun = result.subjectKey?.startsWith("schedule:") ?? false;
  // Imported here rather than at module scope, like every other value this module
  // reaches for: cancel-run.ts is pulled in from paths that must not drag the
  // schedule store behind them.
  const { settleScheduleOccurrenceOnCancel } = await import(
    "../schedule-trigger/occurrence-store.js"
  );
  try {
    const settled = await settleScheduleOccurrenceOnCancel(db, runId);
    if (!settled && isScheduleRun) {
      // No started occurrence carried this run id: the cancel landed in the
      // bind-to-started window. Warn so the miss is observed; the drain's
      // re-dispatch self-remedies.
      logger.warn(
        { runId, subjectKey: result.subjectKey },
        "schedule_run_cancel_occurrence_unsettled",
      );
    }
    return {
      ...result,
      scheduleOccurrenceSettled: isScheduleRun ? settled : null,
    };
  } catch (error) {
    logger.warn(
      {
        runId,
        subjectKey: result.subjectKey ?? null,
        error: (error as Error).message,
      },
      "schedule_run_cancel_occurrence_unsettled",
    );
    return { ...result, scheduleOccurrenceSettled: isScheduleRun ? false : null };
  }
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
): Promise<CancelRunResult> {
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

  let alreadyTerminal = false;
  let tornDown = false;
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
      alreadyTerminal = true;
      logger.info(
        { subjectKey, runId: closed.runId, status },
        "cancel_run_already_terminal",
      );
    }
    // From here the Workflow run will not advance, by cancellation or by its own
    // terminal status. A step handler that was already executing still runs to
    // its end, which is what the drain below waits for. Every return past this
    // point carries the fact so a caller never mistakes unconfirmed bookkeeping
    // for an untouched run.
    tornDown = true;
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
    return { cancelled: false, released: false, tornDown };
  }
  try {
    await stopSandboxesByIds(sandboxIds);
  } catch (err) {
    logger.warn(
      { subjectKey, runId: closed.runId, error: (err as Error).message },
      "cancel_run_sandbox_cleanup_unconfirmed",
    );
    return { cancelled: false, released: false, tornDown };
  }

  if (closed.runId && !(await confirmWorkflowStepsDrained(subjectKey, closed.runId))) {
    return { cancelled: false, released: false, tornDown };
  }

  if (
    closed.runId &&
    !(await retirePostDrainContinuations(subjectKey, closed, closed.runId))
  ) {
    return { cancelled: false, released: false, tornDown };
  }

  if (closed.runId) {
    await settleCancelledPark(subjectKey, closed.runId);
  }

  if (beforeRelease) {
    if (!(await confirmBeforeRelease(subjectKey, closed, beforeRelease))) {
      return { cancelled: false, released: false, tornDown };
    }
  }

  const released = await runRegistry
    .releaseCancellation(subjectKey, closed.ownerToken, closed.runId)
    .catch(() => false);
  if (!released) {
    const refreshed = await runRegistry.get(subjectKey).catch(() => undefined);
    if (refreshed !== null) return { cancelled: false, released: false, tornDown };
  }
  await notifyReleased(subjectKey, onReleased);
  return { cancelled: true, released: true, alreadyTerminal, tornDown };
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
    await recordRunStatusReason(getDb(), runId, reason, {
      kind: "cancellation",
    });
  } catch (error) {
    logger.warn(
      { subjectKey, runId, error: (error as Error).message },
      "cancel_run_status_reason_unconfirmed",
    );
  }
}

/**
 * Best-effort settling of a run cancelled while it was parked on a
 * clarification. That park writes a live "awaiting" the run itself clears when
 * it resumes, which a cancelled run never does, and the cron never downgrades a
 * frozen status: without this the row shows awaiting input forever. Guarded on
 * "awaiting" inside, so it is a no-op for every run that was not parked, and
 * like the cancel reason it must never affect the cancel outcome.
 *
 * Must stay behind the step-drain barrier. Cancelling wakes the parked body,
 * whose own error path flips the run back to "running" on its way out; running
 * this before the drain would let that flip land last and leave the cancelled
 * run reading as in flight. After the barrier no step of the body can write
 * again.
 */
async function settleCancelledPark(subjectKey: string, runId: string): Promise<void> {
  try {
    const [{ getDb }, { markRunBlockedOnCancel }] = await Promise.all([
      import("../db/client.js"),
      import("./telemetry/run-telemetry.js"),
    ]);
    await markRunBlockedOnCancel(getDb(), runId);
  } catch (error) {
    logger.warn(
      { subjectKey, runId, error: (error as Error).message },
      "cancel_run_awaiting_status_unconfirmed",
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
