import { ticketPageUrl } from "../support/dashboard-links.js";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type { IssueTrackerMoveTarget } from "../../adapters/issue-tracker/types.js";
import type { ActiveRunOwner, TicketTransitionOwner } from "../internal/ports.js";
import { isRunControlError } from "../helpers/run-control-error.js";
import { errorMessage } from "../helpers/repository-failure.js";
import type { WorkflowDefinition, WorkflowDefinitionNode } from "@shared/contracts";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";

export async function parkForClarificationStep(
  ticketId: string,
  backlogTarget: IssueTrackerMoveTarget,
  _clarificationRequestId: string,
  owner: TicketTransitionOwner,
): Promise<boolean> {
  "use step";
  const { loadAdaptersPort, loadTicketTransitionPort } = await import(
    "../internal/ports.js"
  );
  const { getDb } = await import("../../db/client.js");
  const { createAdapters } = await loadAdaptersPort();
  const { NEEDS_CLARIFICATION_LABEL } = await import("../support/ticket-labels.js");
  const { updateTicketLabelsForRun } = await import(
    "../support/ticket-label-mutation.js"
  );
  const db = getDb();
  const { issueTracker } = createAdapters();
  // The questions live durably in the clarification store and the overview reads
  // awaiting state from the DB; the caller also posts a best-effort Jira comment
  // with the questions separately (postClarificationQuestionsCommentStep). This
  // step only moves the label/column. The label is ticket-status truth only now
  // (it no longer drives any Jira scan). Best-effort, so a label failure never
  // blocks the park.
  if (typeof issueTracker.updateLabels === "function") {
    try {
      await updateTicketLabelsForRun({
        db,
        issueTracker,
        ticketKey: ticketId,
        owner,
        requiredOwnerState: "bound",
        changes: { add: [NEEDS_CLARIFICATION_LABEL] },
      });
    } catch (err) {
      if (isRunControlError(err)) throw err;
      const { logger } = await import("../../infra/logger.js");
      logger.warn(
        { ticketId, err: errorMessage(err) },
        "clarification_label_add_failed",
      );
    }
  }
  const { moveTicketForRun } = await loadTicketTransitionPort();
  await moveTicketForRun({
    db,
    issueTracker,
    ticketKey: ticketId,
    target: backlogTarget,
    owner,
  });
  return true;
}

export async function reconcileClarificationsOnPickup(
  ticketKey: string,
  currentRunId: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { loadAdaptersPort } = await import("../internal/ports.js");
  const { getDb } = await import("../../db/client.js");
  const { createAdapters } = await loadAdaptersPort();
  const { NEEDS_CLARIFICATION_LABEL } = await import("../support/ticket-labels.js");
  const { updateTicketLabelsForRun } = await import(
    "../support/ticket-label-mutation.js"
  );
  const { reconcileClarificationPickupState } = await import(
    "../../db/repositories/clarifications.js"
  );
  const { issueTracker } = createAdapters();
  const db = getDb();
  // Re-pickup housekeeping, all idempotent so default step retries are safe:
  //  - drop the awaiting-input label (best-effort; a label error must not fail
  //    the fresh run),
  //  - supersede any still-pending clarification (a no-op for a
  //    clarification_answered entry whose row was already answered),
  //  - flip parked predecessor runs off "awaiting" so they don't linger.
  if (typeof issueTracker.updateLabels === "function") {
    try {
      await updateTicketLabelsForRun({
        db,
        issueTracker,
        ticketKey,
        owner,
        requiredOwnerState: "bound",
        changes: { remove: [NEEDS_CLARIFICATION_LABEL] },
      });
    } catch (err) {
      if (isRunControlError(err)) throw err;
      const { logger } = await import("../../infra/logger.js");
      logger.warn(
        { ticketKey, err: errorMessage(err) },
        "clarification_label_remove_failed",
      );
    }
  }
  await reconcileClarificationPickupState(db, {
    ticketKey,
    currentRunId,
    owner,
  });
}

export async function postPickupCommentStep(
  ticketKey: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { loadActiveRunOwnerPort, loadAdaptersPort, loadEnvironmentPort } =
    await import("../internal/ports.js");
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await loadActiveRunOwnerPort();
  const { createAdapters } = await loadAdaptersPort();
  const { env } = await loadEnvironmentPort();
  const { issueTracker } = createAdapters();
  // No run param: the ticket view auto-selects the newest run. The link doubles
  // as the idempotency marker (hasDashboardLinkComment), so this must post at
  // most once per ticket. Best-effort: a post failure must not fail the run.
  const url = ticketPageUrl(env.DASHBOARD_ORIGIN, ticketKey);
  try {
    await assertActiveRunOwner(getDb(), owner);
    await issueTracker.postComment(
      ticketKey,
      `AI workflow picked this ticket up. Follow progress and answer questions in the dashboard: ${url}`,
    );
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { ticketKey, err: errorMessage(err) },
      "pickup_comment_failed",
    );
  }
}
postPickupCommentStep.maxRetries = 0;

export async function postClarificationQuestionsCommentStep(
  ticketKey: string,
  input: {
    questions: string[];
    suggestedAnswers: string[] | null;
    dashboardUrl: string;
    expiresAtIso: string | null;
  },
  owner: ActiveRunOwner,
): Promise<string | null> {
  "use step";
  const { loadActiveRunOwnerPort, loadAdaptersPort, loadEnvironmentPort } =
    await import("../internal/ports.js");
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await loadActiveRunOwnerPort();
  const { createAdapters } = await loadAdaptersPort();
  const { env } = await loadEnvironmentPort();
  const { formatClarificationQuestionsComment } = await import(
    "../support/clarification-comment-format.js"
  );
  const { issueTracker } = createAdapters();
  // Best-effort: surfacing the questions in Jira must never fail the paused run.
  // Returns the comment deep-link on success, null on any failure. A run-control
  // error still rethrows so the workflow ownership CAS is honored.
  try {
    await assertActiveRunOwner(getDb(), owner);
    return await issueTracker.postComment(
      ticketKey,
      formatClarificationQuestionsComment({
        questions: input.questions,
        suggestedAnswers: input.suggestedAnswers,
        dashboardUrl: input.dashboardUrl,
        aiColumnName: env.COLUMN_AI,
        expiresAtIso: input.expiresAtIso,
      }),
    );
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { ticketKey, err: errorMessage(err) },
      "clarification_questions_comment_failed",
    );
    return null;
  }
}
postClarificationQuestionsCommentStep.maxRetries = 0;

async function loadClarificationHistoryStep(
  ticketKey: string,
): Promise<Array<{ questions: string[]; answer: string; answeredBy?: string; answeredAt?: string }>> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { listAnsweredForTicket } = await import("../../db/repositories/clarifications.js");
  const rows = await listAnsweredForTicket(getDb(), ticketKey);
  return rows
    .filter((r) => r.answer !== null)
    .map((r) => ({
      questions: r.questions,
      answer: r.answer as string,
      ...(r.answeredByLabel ? { answeredBy: r.answeredByLabel } : {}),
      ...(r.answeredAt ? { answeredAt: r.answeredAt.toISOString() } : {}),
    }));
}

async function logClarificationHistoryFailure(ticketKey: string, reason: string): Promise<void> {
  "use step";
  const { logger } = await import("../../infra/logger.js");
  logger.warn(
    { ticketKey, reason: reason.slice(0, 1_000) },
    "clarification_history_load_failed",
  );
}
logClarificationHistoryFailure.maxRetries = 0;

async function validateReviewSafePlanStep(
  nodes: WorkflowDefinitionNode[],
  edges: Array<{ from: string; to: string; fromPort?: string }>,
): Promise<string[]> {
  "use step";
  const { validateAnyScopeReviewSafety } = await import("../../workflow-definition/schema.js");
  return validateAnyScopeReviewSafety({ nodes, edges });
}
validateReviewSafePlanStep.maxRetries = 0;

async function resolveAgentKindOverride(labels: readonly string[]): Promise<AgentKind | null> {
  "use step";
  const { parseAgentKindOverride } = await import("../../sandbox/agents/index.js");
  return parseAgentKindOverride(labels);
}

async function resolveHarnessRuntimesStep(
  definition: WorkflowDefinition,
  defaultProvider: AgentKind,
  providerOverride: AgentKind | null,
): Promise<Record<string, ResolvedHarnessRuntime>> {
  "use step";
  const { loadEnvironmentPort } = await import("../internal/ports.js");
  const { env } = await loadEnvironmentPort();
  const { getDb } = await import("../../db/client.js");
  const {
    dashboardOrganizationId,
    resolveHarnessRuntimesForDefinition,
  } = await import("../../workflow-definition/harness-profile-runtime.js");
  const db = getDb();
  const organizationId = await dashboardOrganizationId(
    db,
    env.DASHBOARD_ORG_SLUG,
  );
  return resolveHarnessRuntimesForDefinition(db, {
    definition,
    organizationId,
    defaultProvider,
    providerOverride,
  });
}
resolveHarnessRuntimesStep.maxRetries = 0;
export { loadClarificationHistoryStep, logClarificationHistoryFailure, resolveAgentKindOverride, resolveHarnessRuntimesStep, validateReviewSafePlanStep };
