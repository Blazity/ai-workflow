import { getRun } from "workflow/api";
import type { SettingsSnapshot } from "@shared/contracts";
import { logger } from "../../infra/logger.js";
import type { Db } from "../../db/types.js";
import type {
  ActiveRunEntry,
  RunKind,
  RunRegistryAdapter,
} from "../../adapters/run-registry/types.js";
import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
} from "../../adapters/issue-tracker/types.js";
import { stopSandboxesByIds } from "../../sandbox/stop-ticket-sandboxes.js";
import { ticketSubjectKey } from "./subject-key.js";
import { confirmWorkflowStepsDrained } from "./workflow-step-drain.js";

/**
 * Run statuses the store writes for a run that has reached its outcome. They are
 * the cheap first filter for a claim that may be lingering, and nothing more: a
 * store status is NOT proof the run is over, because markRunSucceededOnSelfMove
 * commits "success" mid-run, before the ticket self-move and everything after it
 * (agent-workflow.ts). Workflow's own status is what retires a run here.
 * "awaiting" is deliberately absent: a run parked on a question is a live park
 * that still owns its subject and is waiting to be resumed, so cancelling one
 * keeps the full teardown. Mirrors the reconciler's STORE_TERMINAL_STATUSES
 * rather than importing it, because reconcile.ts already imports this module.
 */
const STORE_TERMINAL_RUN_STATUSES = new Set(["success", "failed", "blocked"]);

/** Workflow statuses that mean the run will not advance again. Same three the
 * already-terminal branch of cancelOwnedSubject accepts. */
const WORKFLOW_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * How long after its stored completion a finished run that Workflow still reports
 * live is treated as retiring rather than hung. Long enough to cover the tail a
 * run executes after committing its outcome (the ticket move, the notification,
 * the usage write) and Workflow replaying its return; short enough that a tail
 * that hangs, or a run Workflow never retires, is back in an operator's hands
 * within two minutes.
 */
const RETIRING_RUN_GRACE_MS = 2 * 60 * 1000;

/** Claim identity observed by a route before it delegates cancellation. Keeping
 * the owner as well as the stage lets cancellation follow an in-flight
 * reserved-to-bound promotion without ever targeting a replacement owner. */
interface ObservedRunClaim {
  ownerToken: string;
  runId: string | null;
}

export type CancelRunTarget = string | ObservedRunClaim;

type CancelBeforeRelease = (owner: {
  subjectKey: string;
  ownerToken: string;
  runId: string | null;
}) => Promise<void>;

/**
 * What a cancel needs in order to close, on the tracker, a question the run had
 * asked there. Optional everywhere: a caller that holds neither a tracker nor
 * the deployment's column names cancels exactly as it did before, silently, and
 * a subject with no ticket has no such channel at all.
 *
 * The column name is passed in rather than read here for the reason every other
 * settings value on this path is: a service loads no settings of its own, and a
 * comment naming a column this deployment is not configured with would send a
 * person to a board that does not exist.
 */
export interface ClarificationCancelNotice {
  issueTracker: IssueTrackerAdapter;
  /** The board column the comment tells a person to move the ticket back to, so
   *  it reads the same as the questions comment it answers. */
  aiColumnName: string;
}

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
    await cancelRunDetailed({
      ticketKey,
      target,
      runRegistry,
      ...(issueTracker ? { issueTracker } : {}),
      ...(targetColumn ? { targetColumn } : {}),
      ...(onReleased ? { onReleased } : {}),
      ...(reason ? { reason } : {}),
    })
  ).cancelled;
}

/**
 * Everything a ticket-subject cancellation can be told, as one object.
 *
 * It was eight positional parameters, four of them optional and three of them
 * undefined at most call sites, which is unreadable at the call site and is why
 * a ninth was not an option. Every field is named here instead.
 */
export interface CancelRunDetailedInput {
  /** Jira ticket key; its subject key is derived here. */
  ticketKey: string;
  target: CancelRunTarget;
  runRegistry: RunRegistryAdapter;
  issueTracker?: IssueTrackerAdapter;
  /** Column the ticket is moved to under the cancelling owner, before the claim
   *  is released. Without it the cron finds the ticket still in the Ai column on
   *  the next tick and dispatches a fresh run. */
  targetColumn?: IssueTrackerMoveTarget;
  onReleased?: (subjectKey: string) => Promise<void> | void;
  reason?: string;
  /** Replaces the plain column move with the caller's own final fence. */
  beforeRelease?: CancelBeforeRelease;
  /**
   * Set this when the caller knows the deployment's Ai column name, and a
   * cancel that retires a question the ticket was shown will say so on the
   * ticket. Ignored without `issueTracker`, and never a reason to invent a
   * column name: a caller that cannot name the configured column leaves this
   * out and stays silent rather than sending a person to a board that does not
   * exist.
   */
  clarificationNotice?: { aiColumnName: string };
}

/**
 * Same as {@link cancelRun}, but also reports whether the run was already
 * terminal when this call observed it, so a caller (the reconciler) can skip
 * re-notifying operators about a run that already failed or completed on its
 * own.
 */
export async function cancelRunDetailed(
  input: CancelRunDetailedInput,
): Promise<CancelRunResult> {
  const { ticketKey, issueTracker, targetColumn } = input;
  const subjectKey = ticketSubjectKey("jira", ticketKey);
  const confirmTicketMove = issueTracker && targetColumn
    ? async (owner: { subjectKey: string; ownerToken: string; runId: string | null }) => {
      const { moveConnectedTicketForRun } = await import("../tickets/ticket-transition.js");
      await moveConnectedTicketForRun({
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
    input.target,
    input.runRegistry,
    input.onReleased,
    input.beforeRelease ?? confirmTicketMove,
    input.reason,
    issueTracker && input.clarificationNotice
      ? { issueTracker, aiColumnName: input.clarificationNotice.aiColumnName }
      : undefined,
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
  notice?: ClarificationCancelNotice,
): Promise<CancelRunResult> {
  return cancelOwnedSubject(
    subjectKey,
    target,
    runRegistry,
    onReleased,
    undefined,
    reason,
    notice,
  );
}

/**
 * Outcome of an operator cancel-by-id. Distinguishes the four states it can
 * reach so a route (or Slack surface) reports each honestly:
 *   - "cancelled": a live run was found and torn down, and its status settled as
 *     "blocked" with the operator reason. Usually its subject is released too so
 *     a schedule/webhook blocked behind it resumes; when only the teardown could
 *     be confirmed, the dying run's own finally releases the claim instead.
 *   - "already_terminal": the run had already reached a terminal outcome. Either
 *     the run was confirmed over and the claim it left behind was released here,
 *     or Workflow reported it terminal while the claim still lingered, or the run
 *     had already left active_runs. No status is written; `status` carries the
 *     recorded outcome when known.
 *   - "unconfirmed": a live run was found but cancellation never began, so the
 *     Workflow run was never touched and the claim is retained. This is the only
 *     state where a retry is the right advice: once the run is torn down it
 *     cannot be un-cancelled, and that case reports "cancelled" instead. It is
 *     also the answer, with `reason: "retiring"`, for a run that finished within
 *     RETIRING_RUN_GRACE_MS while Workflow is still retiring it: nothing is
 *     touched, and a retry converges, normally to "already_terminal". And it is
 *     the answer, with `reason: "cleanup_unconfirmed"`, for a run Workflow
 *     reports finished whose claim this call could not release because a barrier
 *     declined (steps not drained, sandboxes not confirmed stopped, ticket not
 *     confirmed out of the Ai column, release refused): nothing was touched and
 *     the claim is retained.
 *   - "not_found": neither a live claim nor a workflow_runs row carries the id.
 * `subjectKey` is set whenever a live claim was located.
 */
export interface CancelRunByIdResult {
  outcome: "cancelled" | "already_terminal" | "not_found" | "unconfirmed";
  status?: string;
  subjectKey?: string;
  /** Only on "unconfirmed": "retiring" when the run has already finished and
   * Workflow is still retiring it, so a surface can say that instead of calling
   * the run live; "cleanup_unconfirmed" when Workflow reports the run finished
   * but releasing its claim declined on a barrier, so nothing was touched and
   * the claim is retained. Absent for a live run whose cancel never began. */
  reason?: "retiring" | "cleanup_unconfirmed";
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
  settings: Pick<SettingsSnapshot, "COLUMN_AI" | "COLUMN_BACKLOG">;
  /** Epoch milliseconds, for the retiring window. Defaults to Date.now. */
  now?: () => number;
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
  _db: Db,
  runId: string,
  opts: CancelRunByIdDeps,
): Promise<CancelRunByIdResult> {
  const { actorLabel, runRegistry } = opts;
  const { findConnectedLiveRunClaimByRunId, findConnectedRunOutcomeByRunId } = await import(
    "../../db/repositories/runs.js"
  );

  const claim = await findConnectedLiveRunClaimByRunId(runId);
  if (claim) {
    // A claim carried by a run that is really over is the run's own bookkeeping
    // left behind, not liveness. Without this the leftover claim reads as a live
    // run and the cancel answers "unconfirmed", which is how the engine canary
    // could not release its own finished runs (2026-09-14,
    // wrun_01M2GX079YXKGCF3ZQQ9B9Z91Y). The store status is only the cheap
    // filter; answerForFinishedRun is what tells a finished run from a live one.
    const recorded = await findConnectedRunOutcomeByRunId(runId);
    if (recorded?.status && STORE_TERMINAL_RUN_STATUSES.has(recorded.status)) {
      const answer = await answerForFinishedRun(
        claim,
        runId,
        { status: recorded.status, completedAt: recorded.completedAt },
        opts,
      );
      if (answer) return answer;
    }
    const reason = `cancelled by ${actorLabel}`;
    // An operator cancel is the one cancel a person triggers and then walks
    // away from, so it is the one that most owes the ticket an explanation. It
    // is also the only cancel path that already carries both a tracker and the
    // deployment's column names, which is what the comment needs.
    const clarificationNotice: ClarificationCancelNotice | undefined = opts.issueTracker
      ? { issueTracker: opts.issueTracker, aiColumnName: opts.settings.COLUMN_AI }
      : undefined;
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
            const [{ env }, { withdrawConnectedTicketFromAiForRun }] = await Promise.all([
              import("../../infra/vcs-config.js"),
              import("../tickets/ticket-transition.js"),
            ]);
            await withdrawConnectedTicketFromAiForRun({
              issueTracker: opts.issueTracker!,
              ticketKey: claim.ticketKey!,
              aiColumn: opts.settings.COLUMN_AI,
              target: env.JIRA_BACKLOG_TRANSITION_ID
                ? {
                    name: opts.settings.COLUMN_BACKLOG,
                    transitionId: env.JIRA_BACKLOG_TRANSITION_ID,
                  }
                : opts.settings.COLUMN_BACKLOG,
              owner,
              requiredOwnerState: "cancelling",
            });
          },
          reason,
          clarificationNotice,
        )
      : await cancelSubjectRunDetailed(
          claim.subjectKey,
          { ownerToken: claim.ownerToken, runId },
          runRegistry,
          undefined,
          reason,
          clarificationNotice,
        );
    // alreadyTerminal implies cancelled, so it must be checked first: the run
    // reached a terminal Workflow status on its own and keeps that outcome, so
    // no status is written (only the lingering claim was released).
    if (result.alreadyTerminal) {
      const outcome = await findConnectedRunOutcomeByRunId(runId);
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
      const { markConnectedRunBlockedByOperator } = await import(
        "../../db/repositories/runs/telemetry.js"
      );
      try {
        await markConnectedRunBlockedByOperator(runId, reason);
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
  const outcome = await findConnectedRunOutcomeByRunId(runId);
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
  const { settleConnectedScheduleOccurrenceOnCancel } = await import(
    "../../db/repositories/schedule-triggers.js"
  );
  try {
    const settled = await settleConnectedScheduleOccurrenceOnCancel(runId);
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

export function cancelConnectedRunForOperator(
  runId: string,
  opts: CancelRunByIdDeps,
): Promise<CancelRunForOperatorResult> {
  return cancelRunForOperator(undefined as unknown as Db, runId, opts);
}

/** The live claim a cancel-by-id resolved its run id to. */
interface LiveRunClaim {
  subjectKey: string;
  ticketKey: string | null;
  ownerToken: string;
  kind: RunKind;
}

/**
 * The answer for a live claim whose run the store already records as finished,
 * or null to let the full cancel path answer.
 *
 * - Workflow has retired the run: release the claim it left behind
 *   (releaseLingeringTerminalClaim) and answer "already_terminal". When the
 *   release declines, answer "unconfirmed" and touch nothing, unless the claim is
 *   already "cancelling": that cancel began earlier and has to converge through
 *   the full path. The full path is wrong for any other retired run: its
 *   beginCancellation clears the failed_tickets mark, its cancel reason lands on
 *   a failed row that has none, a teardown with an unconfirmed drain reports a run
 *   that ended on its own as cancelled (and settles a schedule occurrence as
 *   run_cancelled), and for a ticket run it releases the claim with the ticket
 *   still in Ai and the failed mark gone, so the next poll dispatches it again.
 * - Workflow has not retired it yet (or its status is unreadable) and the stored
 *   completion is within RETIRING_RUN_GRACE_MS: answer "unconfirmed" with
 *   `reason: "retiring"` and touch nothing. The run has committed its outcome
 *   and is running its tail or Workflow is replaying its return, so cancelling
 *   would record a good run as cancelled, cut its failure tail (status reason,
 *   Jira comment), or leave its claim in "cancelling". The key goes back into
 *   circulation on "unconfirmed" and a retry converges (the engine canary polls
 *   into exactly this window).
 * - Otherwise the full path: a completion past the window means a tail that
 *   hangs or a run Workflow will not retire, and a null completion carries no
 *   evidence the run just finished. Either way an operator keeps the power to
 *   kill it.
 *
 * Why the completion time and not cost_known: completedAt is written only by a
 * terminal write, and every terminal writer keeps a value that is already set
 * (terminalCompletionFields and its inline copies use coalesce). A live park does
 * not touch it (markRunAwaiting sets only the status) and neither does
 * markRunResumed, so a resumed run carries the completion time of an earlier
 * terminal write or none, and takes the full path; cost_known says only that a
 * usage write happened, which a run can make before it is done (a clarification
 * exit records "awaiting" through it).
 */
async function answerForFinishedRun(
  claim: LiveRunClaim,
  runId: string,
  recorded: { status: string; completedAt: Date | null },
  opts: CancelRunByIdDeps,
): Promise<CancelRunByIdResult | null> {
  if (await isWorkflowRunRetired(claim.subjectKey, runId)) {
    const release = await releaseLingeringTerminalClaim(claim, runId, opts);
    if (release.released) {
      return { outcome: "already_terminal", subjectKey: claim.subjectKey, status: recorded.status };
    }
    if (release.barrier === "claim_cancelling") return null;
    logger.warn(
      {
        subjectKey: claim.subjectKey,
        runId,
        status: recorded.status,
        barrier: release.barrier,
        ...(release.error ? { error: release.error } : {}),
      },
      "cancel_terminal_run_release_declined",
    );
    return { outcome: "unconfirmed", reason: "cleanup_unconfirmed", subjectKey: claim.subjectKey };
  }
  const completedAtMs = recorded.completedAt?.getTime();
  const nowMs = (opts.now ?? Date.now)();
  if (
    completedAtMs !== undefined &&
    Number.isFinite(completedAtMs) &&
    nowMs - completedAtMs <= RETIRING_RUN_GRACE_MS
  ) {
    logger.info(
      { subjectKey: claim.subjectKey, runId, status: recorded.status },
      "cancel_run_still_retiring_unconfirmed",
    );
    return { outcome: "unconfirmed", reason: "retiring", subjectKey: claim.subjectKey };
  }
  return null;
}

/**
 * Release the claim a finished run left on its subject, doing the same bookkeeping
 * the reconciler does for a terminal run and nothing more. Called only once
 * Workflow reports the run retired (answerForFinishedRun).
 *
 * Four barriers, each of which declines rather than guessing and names itself in
 * the result, so the caller can log which one held. The caller answers
 * "unconfirmed" for every decline except "claim_cancelling":
 *
 * 1. Workflow itself reports the run terminal, checked by the caller. A terminal
 *    STORE status is not enough: markRunSucceededOnSelfMove commits "success"
 *    while the run is still moving the ticket and notifying, so releasing on the
 *    store alone would free a subject under a live run. No staleness grace is
 *    applied on top (the
 *    reconciler's readRunOutcomeFromStore has one) because that grace exists to
 *    cover exactly this window, which asking Workflow closes directly, and the
 *    canary needs its claim back seconds after the run ends, not minutes.
 * 2. The claim is still the exact bound owner of this run. "cancelling" goes to
 *    the full path: it belongs to a cancel that began and did not finish, and
 *    converging it needs the clarification tombstone and the cancelling fence that
 *    path carries. "parking" and "parked" are a live park and are not released.
 * 3. Every step has drained (the barrier cleanStoreTerminalRun runs before its
 *    release): a terminal run can still have a handler that started before it went
 *    terminal executing, and releasing under one would let a second run start.
 * 4. The ticket is out of the Ai column and the run's sandboxes are stopped, in
 *    the reconciler's order for a finished ticket run (cleanFinishedManualTicket:
 *    withdraw, then cleanupAndRelease). Releasing a ticket run's claim while the
 *    ticket is still in Ai is what lets the very next poll dispatch a stray run on
 *    it.
 *
 * Nothing here cancels: Workflow is only asked for a status, the claim is never
 * closed, no clarification is retired and no run status is written. The run keeps
 * the outcome it reached on its own.
 *
 * Released also when the claim is already gone, including when the release itself
 * is refused because it went away underneath: the subject is free, which is the whole
 * promise, and the full cancel path would only report an unconfirmed cancellation
 * of a run nobody owns.
 *
 * A claim whose run has outlived Workflow's retention stays with the reconciler,
 * which has the `completedAt` this path does not read; here an unreadable status
 * simply declines.
 */
async function releaseLingeringTerminalClaim(
  claim: LiveRunClaim,
  runId: string,
  opts: CancelRunByIdDeps,
): Promise<TerminalClaimRelease> {
  const { runRegistry } = opts;

  let entry: ActiveRunEntry | null;
  try {
    entry = await runRegistry.get(claim.subjectKey);
  } catch (error) {
    return declined("registry_unreadable", error);
  }
  if (entry === null) return { released: true };
  if (entry.ownerToken !== claim.ownerToken || entry.runId !== runId) {
    return declined("claim_moved");
  }
  if (entry.state === "cancelling") return declined("claim_cancelling");
  if (entry.state !== "bound") return declined("claim_not_bound");

  if (!(await confirmWorkflowStepsDrained(claim.subjectKey, runId))) {
    return declined("drain_pending");
  }

  const withdrawal = await withdrawTerminalTicketFromAi(claim, entry, runId, opts);
  if (withdrawal) return withdrawal;

  let sandboxIds: string[];
  try {
    sandboxIds = await runRegistry.listSandboxes(claim.subjectKey, entry.ownerToken);
  } catch (error) {
    return declined("sandbox_lookup_unconfirmed", error);
  }
  try {
    await stopSandboxesByIds(sandboxIds);
  } catch (error) {
    return declined("sandbox_stop_unconfirmed", error);
  }

  const released = await runRegistry
    .release(claim.subjectKey, entry.ownerToken, runId)
    .catch(() => false);
  if (!released) {
    // The compare-and-delete can match nothing for two different reasons. One is
    // that the claim went away underneath, which is the outcome this was asking
    // for; the other is that it is still held by something this path must not
    // overrule. Only a re-read tells them apart.
    let refreshed: ActiveRunEntry | null;
    try {
      refreshed = await runRegistry.get(claim.subjectKey);
    } catch (error) {
      return declined("release_refused", error);
    }
    if (refreshed !== null) return declined("release_refused");
  }
  logger.info(
    { subjectKey: claim.subjectKey, runId },
    "cancel_released_already_terminal_run",
  );
  return { released: true };
}

/** Which barrier kept a retired run's leftover claim in place. */
type TerminalClaimDecline = {
  released: false;
  barrier:
    | "registry_unreadable"
    | "claim_moved"
    | "claim_cancelling"
    | "claim_not_bound"
    | "drain_pending"
    | "ticket_withdrawal_unavailable"
    | "ticket_withdrawal_unconfirmed"
    | "sandbox_lookup_unconfirmed"
    | "sandbox_stop_unconfirmed"
    | "release_refused";
  error?: string;
};

type TerminalClaimRelease = { released: true } | TerminalClaimDecline;

function declined(
  barrier: TerminalClaimDecline["barrier"],
  error?: unknown,
): TerminalClaimDecline {
  return error === undefined
    ? { released: false, barrier }
    : { released: false, barrier, error: (error as Error).message };
}

/** Workflow's verdict that the run will not advance again. Unreachable counts as
 * live: a status nobody can read is never proof a subject may be freed. */
async function isWorkflowRunRetired(subjectKey: string, runId: string): Promise<boolean> {
  try {
    const status = await getRun(runId).status;
    return WORKFLOW_TERMINAL_STATUSES.has(status);
  } catch (error) {
    logger.warn(
      { subjectKey, runId, error: (error as Error).message },
      "cancel_terminal_run_status_unreachable",
    );
    return false;
  }
}

/**
 * The ticket half of the release, mirroring the withdrawal the reconciler runs
 * before releasing a finished ticket run. Both ticket kinds use the Ai column as
 * execution state, so a claim released while the ticket is still there is read by
 * the very next poll as unowned work and dispatched again: the stray run observed
 * on the canary fixture. Idempotent for a run that did move its ticket:
 * withdrawConnectedTicketFromAiForRun reads the ticket first and returns without a
 * write when it no longer matches the Ai column, under the same owner fence.
 *
 * A ticketless subject (schedule, webhook, PR trigger) has nothing to withdraw and
 * passes straight through. Returns null when the ticket is out of Ai, else the
 * decline naming why it could not be proven out.
 */
async function withdrawTerminalTicketFromAi(
  claim: LiveRunClaim,
  entry: ActiveRunEntry,
  runId: string,
  opts: CancelRunByIdDeps,
): Promise<TerminalClaimDecline | null> {
  if (claim.kind !== "ticket" && claim.kind !== "manual_ticket") return null;
  if (!claim.ticketKey || !opts.issueTracker) {
    return declined("ticket_withdrawal_unavailable");
  }
  try {
    const [{ env }, { withdrawConnectedTicketFromAiForRun }] = await Promise.all([
      import("../../infra/vcs-config.js"),
      import("../tickets/ticket-transition.js"),
    ]);
    await withdrawConnectedTicketFromAiForRun({
      issueTracker: opts.issueTracker,
      ticketKey: claim.ticketKey,
      aiColumn: opts.settings.COLUMN_AI,
      target: env.JIRA_BACKLOG_TRANSITION_ID
        ? {
            name: opts.settings.COLUMN_BACKLOG,
            transitionId: env.JIRA_BACKLOG_TRANSITION_ID,
          }
        : opts.settings.COLUMN_BACKLOG,
      owner: {
        subjectKey: claim.subjectKey,
        ownerToken: entry.ownerToken,
        runId,
      },
      // The claim was never closed by this path, so the fence is the bound owner.
      requiredOwnerState: "bound",
    });
    return null;
  } catch (error) {
    return declined("ticket_withdrawal_unconfirmed", error);
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
  notice?: ClarificationCancelNotice,
): Promise<CancelRunResult> {
  let observed: ObservedRunClaim;
  if (typeof target === "string") {
    const entry = await runRegistry.get(subjectKey).catch(() => {});
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
  let tombstone: {
    matched: boolean;
    successorOwnerToken: string | null;
    retiredPublished: boolean;
  };
  try {
    const { tombstoneConnectedClarificationCancellation } =
      await import("../../db/repositories/clarifications.js");
    tombstone = await tombstoneConnectedClarificationCancellation({
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

  const afterTombstone = await runRegistry.get(subjectKey).catch(() => {});
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
    const refreshed = await runRegistry.get(subjectKey).catch(() => {});
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

  // Whether THIS attempt retired a question a human had been shown. Both
  // tombstones contribute: the first retires the park this cancel found, the
  // post-drain one retires a question a still-executing step published after
  // it. Either way the row is consumed here, so a later attempt reads false and
  // the announcement below happens at most once per cancelled question.
  let retiredPublishedQuestion = tombstone.retiredPublished;
  if (closed.runId) {
    const postDrain = await retirePostDrainContinuations(subjectKey, closed, closed.runId);
    if (!postDrain.retired) {
      return { cancelled: false, released: false, tornDown };
    }
    retiredPublishedQuestion = retiredPublishedQuestion || postDrain.retiredPublished;

    await settleCancelledPark(subjectKey, closed.runId);

    // Ahead of the ticket move and the claim release on purpose: both of those
    // can decline and leave the caller to retry, and a retry finds the question
    // already retired and would say nothing at all.
    if (retiredPublishedQuestion) {
      await announceRetiredClarification(subjectKey, closed, closed.runId, notice);
    }
  }

  if (beforeRelease && !(await confirmBeforeRelease(subjectKey, closed, beforeRelease))) {
    return { cancelled: false, released: false, tornDown };
  }

  const released = await runRegistry
    .releaseCancellation(subjectKey, closed.ownerToken, closed.runId)
    .catch(() => false);
  if (!released) {
    const refreshed = await runRegistry.get(subjectKey).catch(() => {});
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
    const { recordConnectedRunStatusReason } =
      await import("../../db/repositories/runs/telemetry.js");
    await recordConnectedRunStatusReason(runId, reason, {
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
    const { markConnectedRunBlockedOnCancel } =
      await import("../../db/repositories/runs/telemetry.js");
    await markConnectedRunBlockedOnCancel(runId);
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
): Promise<{ retired: boolean; retiredPublished: boolean }> {
  try {
    const [
      { tombstoneConnectedClarificationCancellation },
      { retireConnectedApprovalCancellation },
    ] = await Promise.all([
      import("../../db/repositories/clarifications.js"),
      import("../../db/repositories/approvals.js"),
    ]);
    const tombstone = await tombstoneConnectedClarificationCancellation({
      subjectKey,
      ownerToken: closed.ownerToken,
      runId,
    });
    if (closed.ticketKey) {
      await retireConnectedApprovalCancellation({
        ticketKey: closed.ticketKey,
        runId,
      });
    }
    return { retired: true, retiredPublished: tombstone.retiredPublished === true };
  } catch (error) {
    logger.warn(
      { subjectKey, runId, error: (error as Error).message },
      "cancel_run_post_drain_continuation_cleanup_unconfirmed",
    );
    return { retired: false, retiredPublished: false };
  }
}

/**
 * Tell the tracker the question was asked on that it is no longer open.
 *
 * A cancel retires the clarification in the database and moves the ticket out
 * of the Ai column, and until this existed it said nothing on the ticket at
 * all: the questions comment and the needs-clarification label both stayed,
 * inviting an answer for the week the expiry sentence promised, and the answer
 * a person then wrote reached nobody (observed on production, 2026-09-18).
 *
 * Best effort in both halves, like every other tracker write on this path. The
 * run is already torn down and its claim is about to go; a tracker that refuses
 * a write must not turn a cancel into a failure, and must not stop the other
 * half either, so the two are guarded separately. The comment goes first
 * because a ticket carrying the explanation and a stale label is still
 * readable, while a ticket carrying neither is the defect itself.
 *
 * Exactly-once rests on the caller: this runs only when THIS attempt's
 * tombstone was the one that retired a published question, and a retired row
 * cannot be retired twice. The marker lookup is the second line of defence, for
 * the post whose reply was lost after the tracker had already written it.
 */
async function announceRetiredClarification(
  subjectKey: string,
  closed: ActiveRunEntry,
  runId: string,
  notice: ClarificationCancelNotice | undefined,
): Promise<void> {
  const ticketKey = closed.ticketKey;
  if (!notice || !ticketKey) return;
  const { issueTracker, aiColumnName } = notice;

  try {
    const { clarificationCancelledCommentMarker, formatClarificationCancelledComment } =
      await import("../../engine/support/clarification-comment-format.js");
    const marker = clarificationCancelledCommentMarker(runId);
    const alreadyPosted = issueTracker.findCommentByMarker
      ? (await issueTracker.findCommentByMarker(ticketKey, marker)) !== null
      : false;
    if (!alreadyPosted) {
      await issueTracker.postComment(
        ticketKey,
        formatClarificationCancelledComment({ runId, aiColumnName }),
      );
    }
  } catch (error) {
    logger.warn(
      { subjectKey, runId, ticketKey, error: (error as Error).message },
      "cancel_run_clarification_comment_unconfirmed",
    );
  }

  // The label is the one signal a human scanning the board reads, and after a
  // cancel it says something untrue. Removing it is idempotent, and the helper
  // skips the write entirely when the label is already gone.
  if (typeof issueTracker.updateLabels !== "function") return;
  try {
    const [{ NEEDS_CLARIFICATION_LABEL }, { updateConnectedTicketLabelsForRun }] =
      await Promise.all([
        import("../../engine/support/ticket-labels.js"),
        import("../tickets/ticket-label-mutation.js"),
      ]);
    await updateConnectedTicketLabelsForRun({
      issueTracker,
      ticketKey,
      owner: { subjectKey, ownerToken: closed.ownerToken, runId },
      // The claim was closed by beginCancellation and is not released until
      // this call returns, so the fence is the cancelling owner, exactly as it
      // is for the ticket move that follows.
      requiredOwnerState: "cancelling",
      changes: { remove: [NEEDS_CLARIFICATION_LABEL] },
    });
  } catch (error) {
    logger.warn(
      { subjectKey, runId, ticketKey, error: (error as Error).message },
      "cancel_run_clarification_label_unconfirmed",
    );
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
