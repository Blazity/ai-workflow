import type { SettingsSnapshot, TrackerTicketEvent } from "@shared/contracts";
import { IssueTrackerNotFoundError } from "../../adapters/issue-tracker/types.js";
import { listConnectedApprovalParkedSubjects } from "../../db/repositories/approvals.js";
import { classifyConnectedProtectedClarificationSubjects } from "../../db/repositories/clarifications.js";
import { isConnectedRunRecordedFailed, isConnectedRunRecordedSucceeded } from "../../db/repositories/runs.js";
import { logger } from "../../infra/logger.js";
import { resumeConnectedClarificationFromComments } from "../clarifications/index.js";
import { dispatchTicket } from "../dispatch/index.js";
import { ticketSubject } from "../../engine/support/issue-tracker-runtime.js";
import { cancelRunDetailed } from "../run-lifecycle/index.js";
import { maxConcurrentAgents, ticketBoardSettings } from "../settings/index.js";
import {
  prematureAiReviewCancellationReason,
  decideConnectedAiReviewRun,
  isAiReviewDestination,
} from "../tickets/index.js";
import { createAdapters } from "../../engine/support/adapters.js";
import { issueTrackerOrThrow } from "../../engine/support/connected-issue-tracker.js";
import { TriggerHttpError } from "../../infra/trigger-http-error.js";

/**
 * What a ticket moving means for a run.
 *
 * Core's half of decision 8. Until S12 this lived inside a 792 line Jira
 * webhook handler that verified an HMAC and then dispatched, resumed and
 * cancelled runs directly, so the product's rules about its own runs were
 * written in one provider's file. The integration now reads its provider's
 * bytes and says what happened to a ticket; everything below is the same for
 * the next issue tracker, and nothing in it names one.
 *
 * Every branch here is the branch that was there before, and the recorded
 * deliveries in
 * `apps/worker/src/routes/webhooks/jira-ticket-webhook.characterisation.test.ts`
 * are what says so: that suite passed against the old handler unedited and
 * passes against this.
 *
 * It answers rather than throws, except where the right answer is "ask me
 * again": a lookup that failed must not be read as "nothing to protect", so
 * those raise a retryable error and the provider redelivers.
 */
export interface TicketEventOutcome {
  status: "dispatched" | "resumed" | "skipped" | "cancelled" | "ignored";
  reason?: string;
  ticketKey: string;
}

export async function actOnTicketEvent(
  event: TrackerTicketEvent,
  loadSettings: () => Promise<SettingsSnapshot>,
): Promise<TicketEventOutcome> {
  const ticketKey = event.ticketKey;
  // The board decides which column names this delivery is compared against, so
  // it is resolved from the request's own snapshot rather than from a value
  // read somewhere else. The thunk is memoised per request, so every phase
  // below shares this read.
  const board = await ticketBoardSettings(await loadSettings());
  const resolved = await createAdapters();
  // A tracker's delivery about one of its tickets is ticket work from end to
  // end, so no usable tracker is this event's failure, reported by the
  // webhook route's own handler (the board read above refuses the same way).
  const adapters: Adapters = { ...resolved, issueTracker: issueTrackerOrThrow(resolved) };
  // The one derivation, from the tracker this deployment serves rather than
  // from anything the delivery said about itself. Everything that can later
  // find, cancel or resume this run spells the key this way.
  const subjectKey = await ticketSubject(ticketKey);

  if (event.actor === "self") {
    logger.info(
      { ticketKey, statusChange: event.statusChange },
      "ticket_event_ignored_own_account",
    );
    return { status: "ignored", reason: "workflow_actor", ticketKey };
  }
  if (event.actor === "unknown") {
    // Treated as somebody else, which is the safe direction and what the old
    // handler did when its own-account lookup failed. Said out loud, which the
    // old handler did not do at this level: a deployment whose token cannot
    // read its own account cancels its own runs after its own finalisation
    // moves, and this line is the only warning an operator gets before that
    // starts happening.
    logger.warn(
      { ticketKey, statusChange: event.statusChange },
      "ticket_event_actor_unknown_treated_as_human",
    );
  }

  // A second human move can arrive while an earlier move is already closing
  // the owner. Continue that exact cancellation instead of dispatching against
  // a claim that is deliberately still held.
  if (event.statusChange) {
    const active = await adapters.runRegistry.get(subjectKey);
    if (active?.state === "cancelling") {
      const cancellation = await cancelTrackedRun(
        ticketKey,
        subjectKey,
        adapters,
        board.aiColumn,
        active,
        `Ticket left the AI column (${board.aiColumn} → ${event.statusChange.name ?? "unknown"}) via ${board.trackerName} webhook`,
      );
      if (cancellation === "unconfirmed") {
        throw new TriggerHttpError(503, "Cancellation not confirmed");
      }
      // The run finished on its own exactly as this second human move landed:
      // release the bookkeeping without a "canceled" message or a "cancelled"
      // response, so the run's real outcome stands (mirrors the reconciler's
      // reconcile_released_already_terminal_run path).
      if (cancellation === "already_terminal") {
        logger.info({ ticketKey }, "ticket_event_released_already_terminal_run");
        return { status: "ignored", reason: "already_terminal", ticketKey };
      }
      const cancelled = cancellation === "cancelled";
      if (cancelled) {
        await adapters.messaging.notifyForTicket(ticketKey, {
          kind: "canceled",
          reason: "human changed ticket status while cancellation was in progress",
        });
      }
      return {
        status: cancelled ? "cancelled" : "ignored",
        reason: "human_status_change_during_cancellation",
        ticketKey,
      };
    }
  }

  if (!event.status) {
    logger.info({ ticketKey }, "ticket_event_without_status_dispatching_anyway");
  }

  if (event.status && !isAiColumn(event.status, board)) {
    logger.info(
      { ticketKey, deliveredStatus: event.status, expectedAiStatus: board.aiColumn },
      "ticket_event_outside_ai_column",
    );

    // The delivery's snapshot says where the ticket is now, not what this
    // delivery changed. Pull request triggered remediation legitimately runs
    // while the ticket is outside the AI column, so only a real status change
    // is evidence that a human movement should cancel the active owner.
    if (!event.statusChange) {
      logger.info(
        { ticketKey, deliveredStatus: event.status },
        "ticket_event_outside_ai_without_status_change_ignored",
      );
      return { status: "ignored", reason: "no_status_change", ticketKey };
    }

    const liveTicketState = await liveTicket(ticketKey, adapters, board);
    if (liveTicketState.inAiColumn) {
      logger.info(
        {
          ticketKey,
          deliveredStatus: event.status,
          liveStatus: liveTicketState.status,
          liveProjectKey: liveTicketState.projectKey,
        },
        "ticket_event_skip_cancel_live_ticket_in_ai_column",
      );
      const resumed = await tryResumeClarification(ticketKey, adapters, true, board);
      if (resumed) return resumed;
      return dispatch(ticketKey, adapters, loadSettings, "delivery_outdated_live_ticket_in_ai");
    }

    // The product's OWN finalisation moves this ticket out of the AI column:
    // failure handling moves a failed run's ticket to the backlog, success
    // handling moves a finished run's ticket to AI Review. Both fire this same
    // delivery. AI Review is retained only for a recorded outcome or exact-run
    // durable publication evidence; an active move with neither is a premature
    // human transition and falls through to cancellation. Other columns retain
    // the recorded-outcome guards below.
    const activeRun = await adapters.runRegistry.get(subjectKey).catch(() => null);
    // A manually dispatched pull request run can correlate through a
    // workflow-owned ticket for ownership, but its lifecycle stays
    // provider-driven. A human ticket move must therefore never cancel it.
    if (activeRun?.kind === "manual_pr_trigger") {
      logger.info(
        { ticketKey, runId: activeRun.runId, deliveredStatus: event.status },
        "ticket_event_skip_cancel_manual_pr_dispatch",
      );
      return { status: "ignored", reason: "manual_pr_dispatch_independent", ticketKey };
    }
    let prematureAiReviewTransition = false;
    if (
      await isAiReviewDestination({
        issueTracker: adapters.issueTracker,
        ticketKey,
        statusName: liveTicketState.status,
        statusId: liveTicketState.statusId,
        aiReviewColumn: board.aiReviewColumn,
        trackerIdentity: board.trackerIdentity,
        ...(board.aiReviewTransitionId
          ? { aiReviewTransitionId: board.aiReviewTransitionId }
          : {}),
      })
    ) {
      if (!activeRun?.runId) {
        logger.info(
          { ticketKey, deliveredStatus: event.status, liveStatus: liveTicketState.status },
          "ticket_event_skip_cancel_ticket_in_ai_review_without_active_run",
        );
        return { status: "ignored", reason: "ticket_in_ai_review_column", ticketKey };
      }
      const aiReviewDecision = await decideConnectedAiReviewRun(activeRun.runId);
      if (aiReviewDecision === "lookup_failed") {
        logger.warn(
          { ticketKey, runId: activeRun.runId },
          "ticket_event_ai_review_run_evidence_lookup_failed",
        );
        throw new TriggerHttpError(503, "AI Review run evidence lookup failed");
      }
      if (aiReviewDecision === "retain") {
        logger.info(
          {
            ticketKey,
            runId: activeRun.runId,
            deliveredStatus: event.status,
            liveStatus: liveTicketState.status,
          },
          "ticket_event_skip_cancel_ticket_in_ai_review_column",
        );
        return { status: "ignored", reason: "ticket_in_ai_review_column", ticketKey };
      }
      prematureAiReviewTransition = true;
    }
    if (activeRun?.runId && !prematureAiReviewTransition) {
      let recordedFailed: boolean;
      let recordedSucceeded: boolean;
      try {
        recordedFailed = await isConnectedRunRecordedFailed(activeRun.runId);
        recordedSucceeded = recordedFailed
          ? false
          : await isConnectedRunRecordedSucceeded(activeRun.runId);
      } catch (lookupError) {
        // Do not guess on a lookup failure: treating it as "not terminal"
        // would let this self-triggered delivery cancel a genuinely finished
        // run. Surface a retryable error so the delivery comes again.
        logger.warn(
          { ticketKey, runId: activeRun.runId, err: String(lookupError) },
          "ticket_event_run_failed_lookup_failed",
        );
        throw new TriggerHttpError(503, "Run status lookup failed");
      }
      if (recordedFailed) {
        logger.info(
          { ticketKey, runId: activeRun.runId, deliveredStatus: event.status },
          "ticket_event_skip_cancel_run_already_failed",
        );
        return { status: "ignored", reason: "run_already_failed", ticketKey };
      }
      if (recordedSucceeded) {
        logger.info(
          { ticketKey, runId: activeRun.runId, deliveredStatus: event.status },
          "ticket_event_skip_cancel_run_already_succeeded",
        );
        return { status: "ignored", reason: "run_already_succeeded", ticketKey };
      }
    }

    // Parking for a clarification moves the ticket to the backlog itself,
    // which fires this exact delivery. When the own-account check is dead (a
    // token that cannot read its own account, which arrives here as an
    // `unknown` actor) that self-move reads as a human move and would cancel
    // the run while it waits for a human answer, and tombstone its pending
    // clarification. The cron's parked-subject protection covers exactly this
    // window, so it is reused here. A human aborting a parked run moves the
    // ticket to a column other than the backlog and still cancels.
    if (
      liveTicketState.status !== null &&
      liveTicketState.status.trim().toLowerCase() === board.backlogColumn.trim().toLowerCase()
    ) {
      const protectedSubjects = await classifyConnectedProtectedClarificationSubjects();
      if (protectedSubjects.all.includes(subjectKey)) {
        logger.info(
          { ticketKey, runId: activeRun?.runId ?? null, liveStatus: liveTicketState.status },
          "ticket_event_skip_cancel_run_parked_for_clarification",
        );
        return { status: "ignored", reason: "run_parked_for_clarification", ticketKey };
      }

      // Parking for a plan approval is the same window: the approval step
      // moves the ticket to the backlog itself and its run then ends as
      // "awaiting", which the recorded-outcome guard above does not treat as
      // terminal. Cancelling that self-move would retire the pending approval
      // and leave nobody able to approve the plan. Only the exact run that
      // filed a still dispatch-blocking approval is protected, so an in-flight
      // ticket run or an already dispatched approved continuation still
      // cancels, and any move to a non-backlog column (a human abort) never
      // reaches this branch at all.
      const approvalParkedSubjects = await listConnectedApprovalParkedSubjects();
      if (approvalParkedSubjects.includes(subjectKey)) {
        logger.info(
          { ticketKey, runId: activeRun?.runId ?? null, liveStatus: liveTicketState.status },
          "ticket_event_skip_cancel_run_parked_for_approval",
        );
        return { status: "ignored", reason: "run_parked_for_approval", ticketKey };
      }
    }

    const cancellation = await cancelTrackedRun(
      ticketKey,
      subjectKey,
      adapters,
      board.aiColumn,
      undefined,
      prematureAiReviewTransition
        ? prematureAiReviewCancellationReason(board.trackerName)
        : `Ticket left the AI column (${board.aiColumn} → ${event.status}) via ${board.trackerName} webhook`,
    );
    if (cancellation === "unconfirmed") {
      logger.warn(
        {
          ticketKey,
          deliveredStatus: event.status,
          liveStatus: liveTicketState.status,
          liveProjectKey: liveTicketState.projectKey,
        },
        "ticket_event_cancel_unconfirmed",
      );
      throw new TriggerHttpError(503, "Cancellation not confirmed");
    }
    // The product's own failure or success move races this delivery: the run
    // can reach a terminal status right as the ticket leaves the AI column,
    // before its outcome is frozen for the recorded-outcome guard above.
    // Report that release without a "canceled" message and without claiming
    // "cancelled", so the run's real outcome is never masked.
    if (cancellation === "already_terminal") {
      logger.info(
        {
          ticketKey,
          deliveredStatus: event.status,
          liveStatus: liveTicketState.status,
          liveProjectKey: liveTicketState.projectKey,
        },
        "ticket_event_released_already_terminal_run",
      );
      return { status: "ignored", reason: "already_terminal", ticketKey };
    }
    const cancelled = cancellation === "cancelled";
    if (cancelled) {
      await adapters.messaging.notifyForTicket(ticketKey, {
        kind: "canceled",
        reason: "webhook confirmed ticket is outside AI column",
      });
    }
    logger.info(
      {
        ticketKey,
        deliveredStatus: event.status,
        liveStatus: liveTicketState.status,
        liveProjectKey: liveTicketState.projectKey,
        cancelled,
      },
      "ticket_event_left_ai_column",
    );
    return { status: cancelled ? "cancelled" : "ignored", reason: "left_ai_column", ticketKey };
  }

  const resumed = await tryResumeClarification(
    ticketKey,
    adapters,
    event.statusChange !== null,
    board,
  );
  if (resumed) return resumed;

  return dispatch(ticketKey, adapters, loadSettings, "default");
}

/** The adapters with the tracker this event's handling cannot do without. */
type Adapters = Awaited<ReturnType<typeof createAdapters>> & {
  readonly issueTracker: import("../../adapters/issue-tracker/types.js").IssueTrackerAdapter;
};
type Board = Awaited<ReturnType<typeof ticketBoardSettings>>;

async function dispatch(
  ticketKey: string,
  adapters: Adapters,
  loadSettings: () => Promise<SettingsSnapshot>,
  context: string,
): Promise<TicketEventOutcome> {
  const settings = await loadSettings();
  logger.info(
    { ticketKey, maxConcurrentAgents: maxConcurrentAgents(settings), dispatchContext: context },
    "ticket_event_dispatch_started",
  );
  const result = await dispatchTicket(
    ticketKey,
    adapters,
    maxConcurrentAgents(settings),
    settings,
  );
  logger.info(
    {
      ticketKey,
      started: result.started,
      reason: result.reason,
      runId: result.runId,
      dispatchContext: context,
    },
    "ticket_event_dispatch_result",
  );
  return {
    status: result.started ? "dispatched" : "skipped",
    ticketKey,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

/**
 * A ticket moved into the AI column may carry a suspended run whose answers
 * were left as human comments. Wake that run instead of dispatching. Returns
 * the outcome to report, or null to fall through to dispatch (no clarification,
 * or the live ticket is not in the AI column). The move is the commit gesture,
 * so nudging is only allowed when the delivery carried a real status change.
 */
async function tryResumeClarification(
  ticketKey: string,
  adapters: Adapters,
  allowNudge: boolean,
  board: Board,
): Promise<TicketEventOutcome | null> {
  const resume = await resumeConnectedClarificationFromComments({
    issueTracker: adapters.issueTracker,
    ticketKey,
    allowNudge,
    aiColumn: board.aiColumn,
    cancelSettings: { COLUMN_AI: board.aiColumn, COLUMN_BACKLOG: board.backlogColumn },
  }).catch((err) => {
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "ticket_event_clarification_resume_failed",
    );
    return null;
  });
  if (resume && resume.status !== "no_clarification" && resume.status !== "not_in_ai_column") {
    logger.info(
      { ticketKey, resumeStatus: resume.status, runId: resume.runId },
      "ticket_event_clarification_resume",
    );
    return {
      status: resume.status === "resumed" ? "resumed" : "skipped",
      reason: `clarification_${resume.status}`,
      ticketKey,
    };
  }
  if (resume === null) {
    // Unexpected resume failure: skip dispatch this delivery, the cron retries.
    return { status: "skipped", reason: "clarification_resume_error", ticketKey };
  }
  return null;
}

function isAiColumn(status: string, board: Board): boolean {
  return status.trim().toLowerCase() === board.aiColumn.trim().toLowerCase();
}

async function cancelTrackedRun(
  ticketKey: string,
  subjectKey: string,
  adapters: Adapters,
  /** The board's AI column, so a cancel that retires a question the ticket was
   *  shown can tell that ticket how to start over. This is a human move: the
   *  person dragged the ticket somewhere, and if a question was open they are
   *  the one owed an answer about it. */
  aiColumnName: string,
  /** The owner already in hand, for the caller that is CONTINUING a
   *  cancellation it observed. Omitted, the owner is read here and now: the
   *  guards above this call take time, and cancelling against a claim read
   *  before them would cancel a run that ended while they ran. */
  observedEntry?: Awaited<ReturnType<Adapters["runRegistry"]["get"]>>,
  reason?: string,
): Promise<"cancelled" | "not_active" | "unconfirmed" | "already_terminal"> {
  const entry = observedEntry ?? (await adapters.runRegistry.get(subjectKey));
  if (!entry) return "not_active";
  const cancellationTarget = { ownerToken: entry.ownerToken, runId: entry.runId };

  // Reuse cancelRunDetailed's `alreadyTerminal` discriminator: a run that
  // reached a terminal status on its own is a bookkeeping release, not a fresh
  // cancellation, so callers must not report it as "cancelled".
  const cancel = () =>
    cancelRunDetailed({
      ticketKey,
      target: cancellationTarget,
      runRegistry: adapters.runRegistry,
      issueTracker: adapters.issueTracker,
      ...(reason ? { reason } : {}),
      clarificationNotice: { aiColumnName },
    });

  // A claim with an explicitly NULL run id is a run that never reached the
  // engine, and cancelling it is releasing the claim. A claim with no run id
  // at all is a claim mid-write, and cancelling against it would release
  // somebody else's; it asks again instead.
  if (cancellationTarget.runId === null) {
    const result = await cancel();
    if (!result.cancelled) return "unconfirmed";
    return result.alreadyTerminal ? "already_terminal" : "cancelled";
  }
  if (!cancellationTarget.runId) return "unconfirmed";
  const result = await cancel();
  if (!result.cancelled) return "unconfirmed";
  return result.alreadyTerminal ? "already_terminal" : "cancelled";
}

async function liveTicket(
  ticketKey: string,
  adapters: Adapters,
  board: Board,
): Promise<{
  inAiColumn: boolean;
  status: string | null;
  statusId: string | null;
  projectKey: string | null;
}> {
  try {
    const ticket = await adapters.issueTracker.fetchTicket(ticketKey);
    const status = ticket.trackerStatus;
    const projectKey = ticket.projectKey ?? projectKeyOf(ticket.identifier);
    const inExpectedProject =
      projectKey != null &&
      projectKey.trim().toUpperCase() === board.projectKey.trim().toUpperCase();
    return {
      inAiColumn: isAiColumn(status, board) && inExpectedProject,
      status,
      statusId: ticket.trackerStatusId ?? null,
      projectKey,
    };
  } catch (err) {
    if (err instanceof IssueTrackerNotFoundError || errorCode(err) === "NOT_FOUND") {
      return { inAiColumn: false, status: null, statusId: null, projectKey: null };
    }
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "ticket_event_live_state_check_failed",
    );
    return { inAiColumn: true, status: null, statusId: null, projectKey: null };
  }
}

function projectKeyOf(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const dashIndex = trimmed.indexOf("-");
  if (dashIndex <= 0) return null;
  return trimmed.slice(0, dashIndex).toUpperCase();
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const maybeCode = (err as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
}
