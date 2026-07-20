import { z } from "zod";
import type { IssueTrackerMoveTarget } from "../../adapters/issue-tracker/types.js";
import type { ActiveRunOwner } from "../../lib/active-run-owner.js";
import type { TicketTransitionOwner } from "../../lib/ticket-transition.js";
import { isRunControlError } from "../run-control-error.js";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    mirrorComment: z.boolean().default(true),
  })
  .strict();

async function createApprovalRequestStep(input: {
  ticketKey: string;
  definitionId: number;
  definitionVersion: number | null;
  runId: string;
  plan: { markdown: string };
  assumptions: string[] | null;
}): Promise<string> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { createApprovalRequest } = await import("../../approvals/store.js");
  const row = await createApprovalRequest(getDb(), input);
  return row.id;
}
createApprovalRequestStep.maxRetries = 0;

async function mirrorApprovalCommentStep(
  ticketId: string,
  body: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await import("../../lib/active-run-owner.js");
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  await assertActiveRunOwner(getDb(), owner);
  await issueTracker.postComment(ticketId, body);
}
mirrorApprovalCommentStep.maxRetries = 0;

async function notifyPlanApprovalStep(
  ticketKey: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await import("../../lib/active-run-owner.js");
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { messaging } = createStepAdapters();
  await assertActiveRunOwner(getDb(), owner);
  await messaging.notifyForTicket(ticketKey, { kind: "plan_approval_requested" });
}
notifyPlanApprovalStep.maxRetries = 0;

async function parkForApprovalStep(
  ticketId: string,
  backlogTarget: IssueTrackerMoveTarget,
  owner: TicketTransitionOwner,
): Promise<void> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { AWAITING_APPROVAL_LABEL } = await import("../../lib/labels.js");
  const { updateTicketLabelsForRun } = await import(
    "../../lib/ticket-label-mutation.js"
  );
  const { moveTicketForRun } = await import("../../lib/ticket-transition.js");
  const { issueTracker } = createStepAdapters();
  const db = getDb();
  if (typeof issueTracker.updateLabels === "function") {
    try {
      await updateTicketLabelsForRun({
        db,
        issueTracker,
        ticketKey: ticketId,
        owner,
        requiredOwnerState: "bound",
        changes: { add: [AWAITING_APPROVAL_LABEL] },
      });
    } catch (err) {
      if (isRunControlError(err)) throw err;
      const { logger } = await import("../../lib/logger.js");
      logger.warn(
        { ticketId, err: err instanceof Error ? err.message : String(err) },
        "approval_label_add_failed",
      );
    }
  }
  // The approval row is already committed by the time we park, so a failed move must not
  // fail the block: the plan is filed and pending in the dashboard either way, and letting
  // this throw would report the whole run as failed while the operator sees a pending plan.
  // Log it, because an unparked ticket stays in the AI column and the cron poll can
  // re-dispatch it. Swallowing here rather than in the caller keeps pino inside the step:
  // workflow scope forbids Node modules.
  try {
    await moveTicketForRun({
      db,
      issueTracker,
      ticketKey: ticketId,
      target: backlogTarget,
      owner,
    });
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../../lib/logger.js");
    logger.warn(
      { ticketId, err: err instanceof Error ? err.message : String(err) },
      "approval_park_failed",
    );
  }
}
parkForApprovalStep.maxRetries = 0;

/**
 * send_plan_approval: file the run's plan for human approval, then end the run.
 * The plan text comes from the block's resolved `plan` input. The run's
 * research plan remains a compatibility fallback for stored definitions that
 * predate typed inputs. After unregistering the
 * run it parks the ticket in the backlog column with an awaiting-approval
 * label, mirroring the clarification exit: moving the ticket out of the AI
 * column is what stops the cron poll from re-dispatching it while it waits. A
 * later dashboard approval starts a fresh trigger_plan_approved run, whose
 * dispatch skips the column check so the ticket's backlog location does not
 * block it.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs,
): Promise<BlockExecutionResult> => {
  const markdown =
    typeof resolvedInputs?.plan === "string"
      ? resolvedInputs.plan
      : ctx.researchPlanMarkdown;
  if (markdown.trim().length === 0) {
    return { kind: "failed", output: { status: "failed" }, reason: "no plan available" };
  }

  if (ctx.definitionId === null) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: "approval requires a stored definition",
    };
  }

  const rawAssumptions = resolvedInputs?.assumptions;
  const assumptions = Array.isArray(rawAssumptions)
    ? rawAssumptions.filter((a): a is string => typeof a === "string")
    : [];
  const owner: ActiveRunOwner = {
    subjectKey: ctx.entry.subjectKey,
    ownerToken: ctx.entry.ownerToken,
    runId: ctx.runId,
  };

  let approvalRequestId: string;
  try {
    approvalRequestId = await createApprovalRequestStep({
      ticketKey: ctx.ticket.identifier,
      definitionId: ctx.definitionId,
      // Pin the approval to the version that generated this plan. definitionId is
      // non-null here (guarded above), so a stored definition loaded and its
      // version is the concrete head at load time, never null.
      definitionVersion: ctx.definitionVersion,
      runId: ctx.runId,
      plan: { markdown },
      assumptions: assumptions.length > 0 ? assumptions : null,
    });
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (block.params.mirrorComment !== false) {
    await mirrorApprovalCommentStep(
      ctx.ticket.identifier,
      "Plan awaiting approval in the dashboard.",
      owner,
    ).catch((error) => {
      if (isRunControlError(error)) throw error;
    });
  }

  await notifyPlanApprovalStep(ctx.ticket.identifier, owner).catch((error) => {
    if (isRunControlError(error)) throw error;
  });

  await parkForApprovalStep(ctx.ticket.identifier, ctx.moveTargets.backlog, owner);

  return { kind: "ended", output: { status: "awaiting_approval", approvalRequestId } };
};
