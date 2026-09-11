import { createHmac, timingSafeEqual } from "node:crypto";

import { IssueTrackerNotFoundError } from "../../../adapters/issue-tracker/types.js";
import { listApprovalParkedSubjects } from "../../../db/repositories/approvals.js";
import { classifyProtectedClarificationSubjects } from "../../../db/repositories/clarifications.js";
import { getDb } from "../../../db/client.js";
import { isRunRecordedFailed, isRunRecordedSucceeded } from "../../../db/repositories/runs.js";
import { logger } from "../../../infra/logger.js";
import { resumeClarificationFromComments } from "../../clarifications/index.js";
import { dispatchTicket } from "../../dispatch/index.js";
import { cancelRunDetailed, ticketSubjectKey } from "../../run-lifecycle/index.js";
import {
  jiraWebhookSecret,
  maxConcurrentAgents,
  ticketBoardSettings,
} from "../../settings/index.js";
import { observeProviderWebhook } from "../../system/index.js";
import {
  PREMATURE_AI_REVIEW_CANCELLATION_REASON,
  decideAiReviewRun,
  isAiReviewDestination,
} from "../../tickets/index.js";
import { createAdapters } from "../../vcs/index.js";
import { TriggerHttpError } from "../../../infra/trigger-http-error.js";

/**
 * The Jira webhook, from verified bytes to a decision.
 *
 * The route above this reads the raw body and the signature header and maps what
 * comes back to HTTP; everything else, including which refusals are retryable
 * from Jira's point of view, is decided here.
 *
 * Auth: X-Hub-Signature HMAC (Jira signs the body when a secret is set).
 *
 * KNOWN DEFECT, deliberately preserved by stage 6c: the documented scheme is
 * HMAC-SHA256, but the verifier below takes its hash algorithm from the
 * signature header the sender supplied. Correcting that changes who is
 * authenticated, so it is a security fix with its own ticket, not something a
 * restructure may slip in.
 */
export interface JiraWebhookRequest {
  /** The exact bytes Jira posted, as UTF-8. */
  rawBody: string;
  /** The `x-hub-signature` header, when the sender sent one. */
  signatureHeader: string | undefined;
}

export async function handleJiraWebhook(request: JiraWebhookRequest) {
  try {
    verifyJiraWebhookAuth(request);
  } catch (error) {
    observeProviderWebhook(
      "jira",
      "rejected",
      jiraWebhookSecret() ? "invalid_signature" : "secret_not_configured",
    );
    throw error;
  }
  try {
    const result = await handleVerifiedJiraWebhook(request.rawBody);
    observeProviderWebhook("jira", "accepted", "request_succeeded");
    return result;
  } catch (error) {
    observeProviderWebhook("jira", "rejected", "handler_failed");
    throw error;
  }
}

async function handleVerifiedJiraWebhook(rawBody: string) {
  const body = parseJiraWebhookBody(rawBody);
  const board = ticketBoardSettings();

  const ticketKey = extractTicketKey(body);
  if (!ticketKey) {
    logger.debug({ webhookEvent: body?.webhookEvent }, "webhook_ignored_no_ticket_key");
    return { status: "ignored", reason: "no_ticket_key" };
  }

  const projectKey = extractProjectKey(body);
  if (projectKey && projectKey.toUpperCase() !== board.projectKey.toUpperCase()) {
    logger.debug(
      { ticketKey, projectKey, expectedProject: board.projectKey },
      "webhook_ignored_wrong_project",
    );
    return { status: "ignored", reason: "wrong_project", ticketKey };
  }

  logger.info({ ticketKey }, "webhook_received");

  const adapters = createAdapters();
  const webhookEvent = typeof body?.webhookEvent === "string" ? body.webhookEvent : null;
  const ticketStatus = extractTicketStatus(body);
  const statusChange = extractStatusChange(body);
  const actorAccountId =
    typeof body?.user?.accountId === "string" ? body.user.accountId.trim() : "";
  logger.info(
    {
      ticketKey,
      webhookEvent,
      payloadStatus: ticketStatus,
      statusChange,
      payloadProjectKey: projectKey,
    },
    "webhook_payload_parsed",
  );

  let workflowActorAccountId = "";
  if (webhookEvent === "jira:issue_updated" && statusChange && actorAccountId) {
    try {
      workflowActorAccountId =
        (await adapters.issueTracker.getCurrentUserAccountId?.())?.trim() ?? "";
    } catch (error) {
      logger.warn(
        { ticketKey, error: error instanceof Error ? error.message : String(error) },
        "webhook_workflow_actor_lookup_failed",
      );
    }
  }
  if (
    actorAccountId &&
    workflowActorAccountId &&
    actorAccountId === workflowActorAccountId
  ) {
    logger.info(
      { ticketKey, actorAccountId, statusChange },
      "webhook_ignored_workflow_actor",
    );
    return {
      status: "ignored",
      reason: "workflow_actor",
      ticketKey,
    };
  }

  // A second human move can arrive while an earlier move is already closing
  // the owner. Continue that exact cancellation instead of dispatching against
  // a claim that is deliberately still held.
  if (statusChange) {
    const subjectKey = ticketSubjectKey("jira", ticketKey);
    const active = await adapters.runRegistry.get(subjectKey);
    if (active?.state === "cancelling") {
      const cancellation = await cancelTrackedRun(
        ticketKey,
        adapters.runRegistry,
        adapters.issueTracker,
        active,
        `Ticket left the AI column (${board.aiColumn} → ${statusChange.name ?? "unknown"}) via Jira webhook`,
      );
      if (cancellation === "unconfirmed") {
        throw new TriggerHttpError(503, "Cancellation not confirmed");
      }
      // The run finished on its own exactly as this second human move landed:
      // release the bookkeeping without a "canceled" Slack or a "cancelled"
      // response, so the run's real outcome stands (mirrors the reconciler's
      // reconcile_released_already_terminal_run path).
      if (cancellation === "already_terminal") {
        logger.info({ ticketKey }, "webhook_released_already_terminal_run");
        return {
          status: "ignored",
          reason: "already_terminal",
          ticketKey,
        };
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

  if (!ticketStatus) {
    logger.info({ ticketKey }, "webhook_missing_payload_status_dispatching_anyway");
  }

  if (ticketStatus && !isAiColumnStatus(ticketStatus, board)) {
    logger.info(
      { ticketKey, payloadStatus: ticketStatus, expectedAiStatus: board.aiColumn },
      "webhook_payload_status_outside_ai_column",
    );

    // The issue snapshot says where the ticket is now, not what this webhook
    // changed. PR-triggered remediation legitimately runs while the ticket is
    // outside the AI column, so only an actual status changelog item is
    // evidence that a human movement should cancel the active owner.
    if (!statusChange) {
      logger.info(
        { ticketKey, payloadStatus: ticketStatus },
        "webhook_outside_ai_without_status_change_ignored",
      );
      return {
        status: "ignored",
        reason: "no_status_change",
        ticketKey,
      };
    }

    const liveTicketState = await getLiveTicketState(
      ticketKey,
      adapters.issueTracker,
      board,
    );
    if (liveTicketState.inAiColumn) {
      logger.info(
        {
          ticketKey,
          payloadStatus: ticketStatus,
          liveStatus: liveTicketState.status,
          liveProjectKey: liveTicketState.projectKey,
        },
        "webhook_skip_cancel_live_ticket_in_ai_column",
      );
      const resumeResult = await tryResumeClarification(
        ticketKey,
        adapters,
        Boolean(statusChange),
      );
      if (resumeResult) return resumeResult;

      logger.info(
        {
          ticketKey,
          maxConcurrentAgents: maxConcurrentAgents(),
          dispatchContext: "payload_outdated_live_ticket_in_ai",
        },
        "webhook_dispatch_started",
      );
      const result = await dispatchTicket(ticketKey, adapters, maxConcurrentAgents());
      logger.info(
        {
          ticketKey,
          started: result.started,
          reason: result.reason,
          runId: result.runId,
          dispatchContext: "payload_outdated_live_ticket_in_ai",
        },
        "webhook_dispatch_result",
      );
      return {
        status: result.started ? "dispatched" : "skipped",
        ticketKey,
        reason: result.reason,
      };
    }

    // The bot's OWN finalization moves this ticket out of the AI column: its
    // failure handling moves a failed run's ticket to the backlog, and its
    // success handling moves a finished run's ticket to AI Review. Both fire
    // this exact webhook. AI Review is retained only for a recorded outcome or
    // exact-run durable publication evidence; an active move with neither is a
    // premature human transition and falls through to cancellation. Other
    // columns retain the recorded-outcome guards below.
    const subjectKey = ticketSubjectKey("jira", ticketKey);
    const activeRun = await adapters.runRegistry.get(subjectKey).catch(() => null);
    // Manual PR/MR dispatch can correlate through a workflow-owned Jira ticket
    // for ownership, but its lifecycle remains provider-driven. A human Jira
    // move must therefore never cancel this independently dispatched run.
    if (activeRun?.kind === "manual_pr_trigger") {
      logger.info(
        { ticketKey, runId: activeRun.runId, payloadStatus: ticketStatus },
        "webhook_skip_cancel_manual_pr_dispatch",
      );
      return {
        status: "ignored",
        reason: "manual_pr_dispatch_independent",
        ticketKey,
      };
    }
    let prematureAiReviewTransition = false;
    if (
      await isAiReviewDestination({
        issueTracker: adapters.issueTracker,
        ticketKey,
        statusName: liveTicketState.status,
        statusId: liveTicketState.statusId,
      })
    ) {
      if (!activeRun?.runId) {
        logger.info(
          { ticketKey, payloadStatus: ticketStatus, liveStatus: liveTicketState.status },
          "webhook_skip_cancel_ticket_in_ai_review_without_active_run",
        );
        return { status: "ignored", reason: "ticket_in_ai_review_column", ticketKey };
      }
      const aiReviewDecision = await decideAiReviewRun(getDb(), activeRun.runId);
      if (aiReviewDecision === "lookup_failed") {
        logger.warn(
          { ticketKey, runId: activeRun.runId },
          "webhook_ai_review_run_evidence_lookup_failed",
        );
        throw new TriggerHttpError(503, "AI Review run evidence lookup failed");
      }
      if (aiReviewDecision === "retain") {
        logger.info(
          {
            ticketKey,
            runId: activeRun.runId,
            payloadStatus: ticketStatus,
            liveStatus: liveTicketState.status,
          },
          "webhook_skip_cancel_ticket_in_ai_review_column",
        );
        return { status: "ignored", reason: "ticket_in_ai_review_column", ticketKey };
      }
      prematureAiReviewTransition = true;
    }
    if (activeRun?.runId && !prematureAiReviewTransition) {
      let recordedFailed: boolean;
      let recordedSucceeded: boolean;
      try {
        recordedFailed = await isRunRecordedFailed(getDb(), activeRun.runId);
        recordedSucceeded = recordedFailed
          ? false
          : await isRunRecordedSucceeded(getDb(), activeRun.runId);
      } catch (lookupError) {
        // Do not guess on a lookup failure: treating it as "not terminal" would
        // let this self-triggered webhook cancel a genuinely finished run (the
        // exact masking bug). Surface a retryable error so the webhook is
        // redelivered.
        logger.warn(
          { ticketKey, runId: activeRun.runId, err: String(lookupError) },
          "webhook_run_failed_lookup_failed",
        );
        throw new TriggerHttpError(503, "Run status lookup failed");
      }
      if (recordedFailed) {
        logger.info(
          { ticketKey, runId: activeRun.runId, payloadStatus: ticketStatus },
          "webhook_skip_cancel_run_already_failed",
        );
        return { status: "ignored", reason: "run_already_failed", ticketKey };
      }
      if (recordedSucceeded) {
        logger.info(
          { ticketKey, runId: activeRun.runId, payloadStatus: ticketStatus },
          "webhook_skip_cancel_run_already_succeeded",
        );
        return { status: "ignored", reason: "run_already_succeeded", ticketKey };
      }
    }

    // Parking for a clarification moves the ticket to the backlog itself
    // (parkForClarificationStep), which fires this exact webhook. When the
    // actor-check above is dead (e.g. a Jira token without read:me, so
    // GET /myself 401s), that self-move reads as a human move and would cancel
    // the run while it waits for a human answer — and tombstone its pending
    // clarification. The cron's parked-subject protection covers exactly this
    // window (clarification pending/answered + registry still bound), so reuse
    // it here. A human aborting a parked run moves the ticket to a column
    // other than the backlog and still cancels.
    if (
      liveTicketState.status !== null &&
      liveTicketState.status.trim().toLowerCase() ===
        board.backlogColumn.trim().toLowerCase()
    ) {
      const protectedSubjects = await classifyProtectedClarificationSubjects(getDb());
      if (protectedSubjects.all.includes(subjectKey)) {
        logger.info(
          {
            ticketKey,
            runId: activeRun?.runId ?? null,
            liveStatus: liveTicketState.status,
          },
          "webhook_skip_cancel_run_parked_for_clarification",
        );
        return {
          status: "ignored",
          reason: "run_parked_for_clarification",
          ticketKey,
        };
      }

      // Parking for a plan approval is the same window: send_plan_approval moves
      // the ticket to the backlog itself (parkForApprovalStep) and its run then
      // ends as "awaiting", which the recorded-outcome guard above does not treat
      // as terminal. Cancelling that self-move would retire the pending approval
      // (retireApprovalCancellation) and leave nobody able to approve the plan.
      // Only the exact run that filed a still dispatch-blocking approval is
      // protected, so an in-flight ticket run or an already dispatched approved
      // continuation still cancels, and any move to a non-backlog column
      // (a human abort) never reaches this branch at all.
      const approvalParkedSubjects = await listApprovalParkedSubjects(getDb());
      if (approvalParkedSubjects.includes(subjectKey)) {
        logger.info(
          {
            ticketKey,
            runId: activeRun?.runId ?? null,
            liveStatus: liveTicketState.status,
          },
          "webhook_skip_cancel_run_parked_for_approval",
        );
        return {
          status: "ignored",
          reason: "run_parked_for_approval",
          ticketKey,
        };
      }
    }

    const cancellation = await cancelTrackedRun(
      ticketKey,
      adapters.runRegistry,
      adapters.issueTracker,
      undefined,
      prematureAiReviewTransition
        ? PREMATURE_AI_REVIEW_CANCELLATION_REASON
        : `Ticket left the AI column (${board.aiColumn} → ${ticketStatus}) via Jira webhook`,
    );
    if (cancellation === "unconfirmed") {
      logger.warn(
        {
          ticketKey,
          payloadStatus: ticketStatus,
          liveStatus: liveTicketState.status,
          liveProjectKey: liveTicketState.projectKey,
        },
        "webhook_ticket_cancel_unconfirmed",
      );
      throw new TriggerHttpError(503, "Cancellation not confirmed");
    }
    // The bot's own failure/success move races this webhook: the run can reach
    // a terminal Workflow status right as the ticket leaves the AI column,
    // before its outcome is frozen for the recorded-outcome guard above. Report
    // that release without a "canceled" Slack or a "cancelled" response, so the
    // run's real outcome (failed/success) is never masked as a cancellation
    // (mirrors the reconciler's reconcile_released_already_terminal_run path).
    if (cancellation === "already_terminal") {
      logger.info(
        {
          ticketKey,
          payloadStatus: ticketStatus,
          liveStatus: liveTicketState.status,
          liveProjectKey: liveTicketState.projectKey,
        },
        "webhook_released_already_terminal_run",
      );
      return {
        status: "ignored",
        reason: "already_terminal",
        ticketKey,
      };
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
        payloadStatus: ticketStatus,
        liveStatus: liveTicketState.status,
        liveProjectKey: liveTicketState.projectKey,
        cancelled,
      },
      "webhook_ticket_left_ai_column",
    );
    return {
      status: cancelled ? "cancelled" : "ignored",
      reason: "left_ai_column",
      ticketKey,
    };
  }

  const resumeResult = await tryResumeClarification(
    ticketKey,
    adapters,
    Boolean(statusChange),
  );
  if (resumeResult) return resumeResult;

  logger.info(
    {
      ticketKey,
      maxConcurrentAgents: maxConcurrentAgents(),
      dispatchContext: "default",
    },
    "webhook_dispatch_started",
  );
  const result = await dispatchTicket(ticketKey, adapters, maxConcurrentAgents());

  logger.info(
    { ticketKey, started: result.started, reason: result.reason, runId: result.runId },
    "webhook_dispatch_result",
  );

  return {
    status: result.started ? "dispatched" : "skipped",
    ticketKey,
    reason: result.reason,
  };
}

// ---------------------------------------------------------------------------
// Clarification resume
// ---------------------------------------------------------------------------

/**
 * A ticket moved into the AI column may carry a suspended clarification run
 * whose answers were left as human comments. Wake that run instead of
 * dispatching. Returns the handler response to send, or null to fall through
 * to dispatchTicket (no clarification, or the live ticket is not in AI). The
 * move is the commit gesture, so nudging is only allowed when the delivery
 * carries a real status changelog item.
 */
async function tryResumeClarification(
  ticketKey: string,
  adapters: ReturnType<typeof createAdapters>,
  allowNudge: boolean,
): Promise<{ status: string; reason: string; ticketKey: string } | null> {
  const resume = await resumeClarificationFromComments({
    db: getDb(),
    issueTracker: adapters.issueTracker,
    ticketKey,
    allowNudge,
  }).catch((err) => {
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "webhook_clarification_resume_failed",
    );
    return null;
  });
  if (
    resume &&
    resume.status !== "no_clarification" &&
    resume.status !== "not_in_ai_column"
  ) {
    logger.info(
      { ticketKey, resumeStatus: resume.status, runId: resume.runId },
      "webhook_clarification_resume",
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
  // fall through to dispatchTicket (returns already_claimed / not_in_ai itself)
  return null;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Verify the X-Hub-Signature HMAC Jira Cloud sent, against the raw bytes.
 *
 * Runs before anything parses the payload, so a body that never authenticated is
 * never interpreted.
 */
function verifyJiraWebhookAuth(request: JiraWebhookRequest): void {
  const secret = jiraWebhookSecret();
  if (!secret) {
    throw new TriggerHttpError(503, "Jira webhook is not configured");
  }

  if (!request.signatureHeader) {
    throw new TriggerHttpError(401, "Missing X-Hub-Signature header");
  }

  verifyHmacSignature(request.rawBody, request.signatureHeader, secret);
}

function verifyHmacSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): void {
  const [method, receivedSig] = signatureHeader.split("=", 2);
  if (!method || !receivedSig) {
    throw new TriggerHttpError(401, "Malformed X-Hub-Signature header");
  }

  // The algorithm comes from the sender's own header. See the defect note at the
  // top of this file: stage 6c preserves this byte for byte.
  const expectedSig = createHmac(method, secret).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(receivedSig, "hex");
  const b = Buffer.from(expectedSig, "hex");

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TriggerHttpError(401, "Invalid webhook signature");
  }
}

/** Jira posts JSON; an empty body is the keepalive shape and means "no issue". */
function parseJiraWebhookBody(rawBody: string): any {
  return rawBody ? JSON.parse(rawBody) : {};
}

// ---------------------------------------------------------------------------
// Payload parsing — Jira Cloud webhook payloads
// ---------------------------------------------------------------------------

/**
 * Extract the issue key from a Jira webhook payload.
 * Jira sends `issue.key` (e.g. "AWT-42") in most webhook event types.
 */
function extractTicketKey(body: any): string | null {
  return body?.issue?.key ?? null;
}

/**
 * Extract the project key from a Jira webhook payload.
 * Available at `issue.fields.project.key` (e.g. "AWT").
 */
function extractProjectKey(body: any): string | null {
  return body?.issue?.fields?.project?.key ?? null;
}

function extractTicketStatus(body: any): string | null {
  return body?.issue?.fields?.status?.name ?? null;
}

/** The issue snapshot describes current state but not what this webhook
 * changed. Echo suppression must match Jira's exact status changelog item. */
function extractStatusChange(
  body: any,
): { id?: string; name?: string } | null {
  const items = Array.isArray(body?.changelog?.items) ? body.changelog.items : [];
  const change = items.find(
    (item: any) => typeof item?.field === "string" && item.field.toLowerCase() === "status",
  );
  if (!change) return null;

  const id = change.to == null ? "" : String(change.to).trim();
  const name = typeof change.toString === "string" ? change.toString.trim() : "";
  if (!id && !name) return null;
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
  };
}

function isAiColumnStatus(status: string, board: TicketBoard): boolean {
  return status.trim().toLowerCase() === board.aiColumn.trim().toLowerCase();
}

async function cancelTrackedRun(
  ticketKey: string,
  runRegistry: ReturnType<typeof createAdapters>["runRegistry"],
  issueTracker: ReturnType<typeof createAdapters>["issueTracker"],
  observedEntry?: Awaited<ReturnType<typeof runRegistry.get>>,
  reason?: string,
): Promise<"cancelled" | "not_active" | "unconfirmed" | "already_terminal"> {
  const subjectKey = ticketSubjectKey("jira", ticketKey);
  const entry = observedEntry ?? (await runRegistry.get(subjectKey));
  if (!entry) return "not_active";
  const cancellationTarget = {
    ownerToken: entry.ownerToken,
    runId: entry.runId,
  };

  // Reuse cancelRunDetailed's `alreadyTerminal` discriminator: a run that
  // reached a terminal Workflow status on its own (its cancel() threw, status
  // was already completed/failed/cancelled) is a bookkeeping release, not a
  // fresh cancellation, so callers must not report it as "cancelled".
  if (cancellationTarget.runId === null) {
    const result = await cancelRunDetailed(
      ticketKey,
      cancellationTarget,
      runRegistry,
      issueTracker,
      undefined,
      undefined,
      reason,
    );
    if (!result.cancelled) return "unconfirmed";
    return result.alreadyTerminal ? "already_terminal" : "cancelled";
  }

  if (!cancellationTarget.runId) return "unconfirmed";
  const result = await cancelRunDetailed(
    ticketKey,
    cancellationTarget,
    runRegistry,
    issueTracker,
    undefined,
    undefined,
    reason,
  );
  if (!result.cancelled) return "unconfirmed";
  return result.alreadyTerminal ? "already_terminal" : "cancelled";
}

async function getLiveTicketState(
  ticketKey: string,
  issueTracker: ReturnType<typeof createAdapters>["issueTracker"],
  board: TicketBoard,
): Promise<{
  inAiColumn: boolean;
  status: string | null;
  statusId: string | null;
  projectKey: string | null;
}> {
  try {
    const liveTicket = await issueTracker.fetchTicket(ticketKey);
    const status = liveTicket.trackerStatus;
    const projectKey = liveTicket.projectKey ?? extractProjectKeyFromIdentifier(liveTicket.identifier);
    const inExpectedProject =
      projectKey != null &&
      projectKey.trim().toUpperCase() === board.projectKey.trim().toUpperCase();
    return {
      inAiColumn: isAiColumnStatus(status, board) && inExpectedProject,
      status,
      statusId: liveTicket.trackerStatusId ?? null,
      projectKey,
    };
  } catch (err) {
    if (err instanceof IssueTrackerNotFoundError || getErrorCode(err) === "NOT_FOUND") {
      return { inAiColumn: false, status: null, statusId: null, projectKey: null };
    }
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "webhook_live_ticket_state_check_failed",
    );
    return { inAiColumn: true, status: null, statusId: null, projectKey: null };
  }
}

function extractProjectKeyFromIdentifier(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const dashIndex = trimmed.indexOf("-");
  if (dashIndex <= 0) return null;
  return trimmed.slice(0, dashIndex).toUpperCase();
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const maybeCode = (err as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
}

/** The board coordinates every branch above compares a ticket against. */
type TicketBoard = ReturnType<typeof ticketBoardSettings>;
