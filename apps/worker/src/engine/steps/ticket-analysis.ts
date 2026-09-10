/* eslint-disable max-lines, max-lines-per-function */
import { ticketRunUrl } from "../../services/publication/dashboard-links.js";
import type { TicketEvent } from "../../adapters/messaging/types.js";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import { type WorkflowExecutionLogEvent } from "../../workflow-definition/interpreter.js";
import { configuredReplaySecrets } from "../../run-observability/configured-secrets.js";
import { sanitizeReplayValue } from "../../run-observability/sanitizer.js";
import { type AgentWorkflowInput } from "../agent-input.js";
import type { ActiveRunOwner, TicketTransitionOwner } from "../internal/ports.js";
import { analysisCommentMarker, buildApprovedPlanAnalysisReport, buildResearchAnalysisReport, formatPublishedAnalysisComment, formatResearchAnalysisComment, hasAnalysisComment } from "../../run-analysis/report.js";
import { isRunControlError } from "../helpers/run-control-error.js";
import { errorMessage } from "../helpers/repository-failure.js";
import type { RunAnalysisReport } from "@shared/contracts";

export async function postPrLinksComment(
  ticketId: string,
  prs: Array<{ provider: SelectedRepository["provider"]; repoPath: string; url: string; id: number }>,
  owner: ActiveRunOwner,
  heading = "Pull requests ready for review:",
): Promise<void> {
  "use step";
  const { loadActiveRunOwnerPort, loadAdaptersPort } = await import(
    "../internal/ports.js"
  );
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await loadActiveRunOwnerPort();
  const { createAdapters } = await loadAdaptersPort();
  const { issueTracker } = createAdapters();
  const lines = prs.map((pr) => `- ${pr.provider}:${pr.repoPath}: #${pr.id} ${pr.url}`);
  try {
    await assertActiveRunOwner(getDb(), owner);
    await issueTracker.postComment(ticketId, `${heading}\n${lines.join("\n")}`);
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { ticketId, prs, err: errorMessage(err) },
      "pr_links_comment_failed",
    );
  }
}
postPrLinksComment.maxRetries = 0;

/** Durable report writer kept as a workflow step so a replay/cold resume can
 * safely retry the database boundary without importing the DB client into the
 * workflow bundle. */
async function recordRunAnalysisReportStep(report: RunAnalysisReport): Promise<void> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { logger } = await import("../../infra/logger.js");
  const { recordRunAnalysisReport } = await import("../../run-analysis/store.js");
  await recordRunAnalysisReport(getDb(), report);
  logger.info({ runId: report.runId, stage: report.stage }, "run_analysis_report_recorded");
}
recordRunAnalysisReportStep.maxRetries = 2;

export async function recordRunAnalysisReportBestEffort(report: RunAnalysisReport): Promise<boolean> {
  try {
    await recordRunAnalysisReportStep(report);
    return true;
  } catch (error) {
    console.warn(
      `[agent] run analysis report persistence failed: ${safeRunAnalysisReportError(error)}`,
    );
    return false;
  }
}

async function loadApprovedPlanAnalysisReportStep(
  runId: string,
  sourceRunId: string | undefined,
  approvedPlan: AgentWorkflowInput & { kind: "plan_approved" },
): Promise<RunAnalysisReport> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { getRunAnalysisReport } = await import("../../run-analysis/store.js");
  const source = sourceRunId ? await getRunAnalysisReport(getDb(), sourceRunId) : null;
  return buildApprovedPlanAnalysisReport({
    runId,
    sourceRunId: sourceRunId ?? null,
    sourceReport: source,
    approvedPlan: approvedPlan.approvedPlan,
  });
}
loadApprovedPlanAnalysisReportStep.maxRetries = 2;

export async function loadApprovedPlanAnalysisReportBestEffort(
  runId: string,
  sourceRunId: string | undefined,
  approvedPlan: AgentWorkflowInput & { kind: "plan_approved" },
): Promise<RunAnalysisReport | null> {
  try {
    return await loadApprovedPlanAnalysisReportStep(runId, sourceRunId, approvedPlan);
  } catch (error) {
    console.warn(
      `[agent] approved run analysis report unavailable: ${safeRunAnalysisReportError(error)}`,
    );
    return null;
  }
}

function buildResearchAnalysisReportBestEffort(
  input: Parameters<typeof buildResearchAnalysisReport>[0],
): RunAnalysisReport | null {
  try {
    return buildResearchAnalysisReport(input);
  } catch (error) {
    console.warn(
      `[agent] research analysis report unavailable: ${safeRunAnalysisReportError(error)}`,
    );
    return null;
  }
}

/** Fetch-before-post makes a lost POST response idempotent: a retry sees the
 * marker and returns a posted delivery instead of creating a duplicate. */
export async function postRunAnalysisCommentStep(
  ticketKey: string,
  report: RunAnalysisReport,
  stage: "research" | "pull_request",
  owner: ActiveRunOwner,
): Promise<import("@shared/contracts").RunAnalysisCommentDelivery> {
  "use step";
  const { loadActiveRunOwnerPort, loadAdaptersPort, loadEnvironmentPort } =
    await import("../internal/ports.js");
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await loadActiveRunOwnerPort();
  const { createAdapters } = await loadAdaptersPort();
  const { env } = await loadEnvironmentPort();
  const { issueTracker } = createAdapters();
  await assertActiveRunOwner(getDb(), owner);
  const attemptedAt = new Date().toISOString();
  const marker = analysisCommentMarker(report.runId, stage);
  let existingCommentUrl: string | null | undefined;
  if (issueTracker.findCommentByMarker) {
    existingCommentUrl =
      (await issueTracker.findCommentByMarker(ticketKey, marker)) ?? undefined;
  } else {
    existingCommentUrl = hasAnalysisComment(
      await issueTracker.fetchTicket(ticketKey),
      marker,
    )
      ? null
      : undefined;
  }
  if (existingCommentUrl !== undefined) {
    const { logger } = await import("../../infra/logger.js");
    logger.info({ runId: report.runId, stage, ticketKey }, "run_analysis_comment_skipped_duplicate");
    return { state: "posted", attemptedAt, commentUrl: existingCommentUrl, error: null };
  }
  const dashboardUrl = ticketRunUrl(env.DASHBOARD_ORIGIN, ticketKey, report.runId);
  const body = stage === "research"
    ? formatResearchAnalysisComment(report, dashboardUrl)
    : formatPublishedAnalysisComment(report, dashboardUrl);
  await assertActiveRunOwner(getDb(), owner);
  const commentUrl = await issueTracker.postComment(ticketKey, body);
  const { logger } = await import("../../infra/logger.js");
  logger.info({ runId: report.runId, stage, ticketKey }, "run_analysis_comment_posted");
  return { state: "posted", attemptedAt, commentUrl, error: null };
}
postRunAnalysisCommentStep.maxRetries = 2;

async function recordRunAnalysisCommentFailureStep(
  runId: string,
  stage: "research" | "pull_request",
  error: string,
): Promise<void> {
  "use step";
  const { logger } = await import("../../infra/logger.js");
  logger.warn({ runId, stage, error }, "run_analysis_comment_failed");
}
recordRunAnalysisCommentFailureStep.maxRetries = 0;

async function recordRunAnalysisCommentFailureBestEffort(
  runId: string,
  stage: "research" | "pull_request",
  error: string,
): Promise<void> {
  try {
    await recordRunAnalysisCommentFailureStep(runId, stage, error);
  } catch (loggingError) {
    console.warn(
      `[agent] run analysis comment failure logging failed: ${safeRunAnalysisReportError(loggingError)}`,
    );
  }
}

function safeRunAnalysisDeliveryError(error: unknown): string {
  return safeRunAnalysisError(error, "Jira analysis report delivery failed.");
}

function safeRunAnalysisReportError(error: unknown): string {
  return safeRunAnalysisError(error, "Run analysis report capture failed.");
}

function safeRunAnalysisError(error: unknown, fallback: string): string {
  const envelope = sanitizeReplayValue(errorMessage(error), {
    secrets: configuredReplaySecrets(),
    maxBytes: 2 * 1024,
  });
  return !envelope.metadata.unavailable && typeof envelope.value === "string"
    ? envelope.value
    : fallback;
}

/** Posts the comment and hands back the tracker's deep link to it when the
 *  provider exposes one, so callers can point a notification at the comment.
 *  Callers that only need the comment posted may ignore the return value. */
export async function postTicketComment(
  ticketId: string,
  comment: string,
  owner: ActiveRunOwner,
): Promise<string | null> {
  "use step";
  const { loadActiveRunOwnerPort, loadAdaptersPort } = await import(
    "../internal/ports.js"
  );
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await loadActiveRunOwnerPort();
  const { createAdapters } = await loadAdaptersPort();
  const { issueTracker } = createAdapters();
  await assertActiveRunOwner(getDb(), owner);
  return issueTracker.postComment(ticketId, comment);
}

export async function notifyTicket(
  ticketKey: string,
  event: TicketEvent,
  owner: ActiveRunOwner,
) {
  "use step";
  const { loadActiveRunOwnerPort, loadAdaptersPort } = await import(
    "../internal/ports.js"
  );
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await loadActiveRunOwnerPort();
  const { createAdapters } = await loadAdaptersPort();
  const { messaging } = createAdapters();
  await assertActiveRunOwner(getDb(), owner);
  await messaging.notifyForTicket(ticketKey, event);
}

export async function notifyTicketBestEffort(
  ticketKey: string,
  event: TicketEvent,
  owner: ActiveRunOwner,
): Promise<void> {
  try {
    await notifyTicket(ticketKey, event, owner);
  } catch (error) {
    if (isRunControlError(error)) throw error;
    console.error(`Ticket notification failed for ${ticketKey}`);
  }
}

/**
 * State on the ticket why the run failed, in the same words every other surface
 * uses.
 *
 * Before AIW-254 a failed run moved its ticket back to the backlog and said
 * nothing, so the only reader who could see the reason was an operator with
 * dashboard access; the client whose ticket bounced had to ask. The `reason`
 * handed here is byte-for-byte the string `recordRunFailureReasonStep` persists
 * for the run header and the run list and the one the Slack notification carries.
 *
 * Deliberately NOT passed through `scrubForPublication`. That scrub is built for
 * agent-authored prose and its markers (an absolute sandbox path, "memory
 * document") match text a captured provider tail can legitimately contain, so it
 * would delete the reason from this surface only and make the four surfaces
 * disagree. The control that makes this text publishable is the sanitizer it was
 * already composed by: secrets redacted, stack frames stripped, bounded length.
 *
 * Best-effort in the strongest sense: a ticket comment must never change a run's
 * outcome.
 */
async function postFailureReasonCommentStep(
  ticketKey: string,
  reason: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { loadActiveRunOwnerPort, loadAdaptersPort } = await import(
    "../internal/ports.js"
  );
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await loadActiveRunOwnerPort();
  const { createAdapters } = await loadAdaptersPort();
  const { issueTracker } = createAdapters();
  try {
    await assertActiveRunOwner(getDb(), owner);
    await issueTracker.postComment(ticketKey, reason);
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { ticketKey, err: errorMessage(err) },
      "failure_reason_comment_failed",
    );
  }
}
postFailureReasonCommentStep.maxRetries = 0;

async function logPhaseFailure(
  ticketKey: string,
  phase: string,
  reason: string,
): Promise<void> {
  "use step";
  const { logger } = await import("../../infra/logger.js");
  logger.warn(
    { ticketKey, phase, reason: reason.slice(0, 1_000) },
    "agent_phase_failed",
  );
}
logPhaseFailure.maxRetries = 0;

/**
 * Records the run's "failed" status before its failure-handling backlog move
 * fires the self-triggered "ticket left the AI column" webhook, so that webhook
 * cannot cancel the run out of a genuine failure. See markRunFailedOnSelfMove.
 */
async function markRunFailedOnSelfMoveStep(runId: string): Promise<void> {
  "use step";
  const { loadRunTelemetryPort } = await import("../internal/ports.js");
  const { getDb } = await import("../../db/client.js");
  const { markRunFailedOnSelfMove } = await loadRunTelemetryPort();
  await markRunFailedOnSelfMove(getDb(), runId);
}
markRunFailedOnSelfMoveStep.maxRetries = 0;

/**
 * Persist the concrete reason a run failed so the trace screen can state it.
 * Without this the only durable reason a failed run ever carried was written by
 * a later cancellation (the reconciler retiring the orphan after the failure
 * moved its ticket out of the AI column), which reads as bookkeeping and hides
 * the real cause. Best-effort: reporting must never change the failure outcome.
 */
async function recordRunFailureReasonStep(
  runId: string,
  reason: string,
): Promise<void> {
  "use step";
  const { loadRunTelemetryPort } = await import("../internal/ports.js");
  const [{ getDb }, { recordRunStatusReason }, { logger }] = await Promise.all([
    import("../../db/client.js"),
    loadRunTelemetryPort(),
    import("../../infra/logger.js"),
  ]);
  try {
    await recordRunStatusReason(getDb(), runId, reason.slice(0, 2_000), {
      kind: "failure",
    });
  } catch (error) {
    logger.warn(
      { runId, err: error instanceof Error ? error.message : String(error) },
      "run_failure_reason_unconfirmed",
    );
  }
}
recordRunFailureReasonStep.maxRetries = 0;

/**
 * Records the run's "success" status before its success-finalizing AI Review
 * move fires the self-triggered "ticket left the AI column" webhook, so that
 * webhook cannot cancel the run out of a genuine success. See
 * markRunSucceededOnSelfMove.
 */
async function markRunSucceededOnSelfMoveStep(runId: string): Promise<void> {
  "use step";
  const { loadRunTelemetryPort } = await import("../internal/ports.js");
  const { getDb } = await import("../../db/client.js");
  const { markRunSucceededOnSelfMove } = await loadRunTelemetryPort();
  await markRunSucceededOnSelfMove(getDb(), runId);
}
markRunSucceededOnSelfMoveStep.maxRetries = 0;

async function logWorkflowExecutionErrorStep(
  event: WorkflowExecutionLogEvent,
): Promise<void> {
  "use step";
  const { logger } = await import("../../infra/logger.js");
  logger.error(event, "workflow_execution_error");
}
logWorkflowExecutionErrorStep.maxRetries = 0;

async function markTicketFailed(
  ticketIdentifier: string,
  runId: string,
  error: string,
  owner: TicketTransitionOwner,
) {
  "use step";
  const { loadAdaptersPort } = await import("../internal/ports.js");
  const { createAdapters } = await loadAdaptersPort();
  const { runRegistry } = createAdapters();
  if (!owner.runId) throw new Error("Failed-ticket marking requires a bound run owner.");
  await runRegistry.markFailed(ticketIdentifier, {
    runId,
    error,
    failedAt: new Date().toISOString(),
  }, {
    subjectKey: owner.subjectKey,
    ownerToken: owner.ownerToken,
    runId: owner.runId,
  });
}
export { buildResearchAnalysisReportBestEffort, logPhaseFailure, logWorkflowExecutionErrorStep, markRunFailedOnSelfMoveStep, markRunSucceededOnSelfMoveStep, markTicketFailed, postFailureReasonCommentStep, recordRunAnalysisCommentFailureBestEffort, recordRunFailureReasonStep, safeRunAnalysisDeliveryError, safeRunAnalysisReportError };
