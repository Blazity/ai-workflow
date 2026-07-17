import { z } from "zod";
import type { IssueTrackerMoveTarget } from "../../adapters/issue-tracker/types.js";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    planFromStep: z.string().trim().min(1).optional(),
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

async function mirrorApprovalCommentStep(ticketId: string, body: string): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  await issueTracker.postComment(ticketId, body);
}
mirrorApprovalCommentStep.maxRetries = 0;

async function notifyPlanApprovalStep(ticketKey: string): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { messaging } = createStepAdapters();
  await messaging.notifyForTicket(ticketKey, { kind: "plan_approval_requested" });
}
notifyPlanApprovalStep.maxRetries = 0;

async function parkForApprovalStep(
  ticketId: string,
  backlogTarget: IssueTrackerMoveTarget,
): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { AWAITING_APPROVAL_LABEL } = await import("../../lib/labels.js");
  const { issueTracker } = createStepAdapters();
  if (typeof issueTracker.updateLabels === "function") {
    try {
      await issueTracker.updateLabels(ticketId, { add: [AWAITING_APPROVAL_LABEL] });
    } catch (err) {
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
    await issueTracker.moveTicket(ticketId, backlogTarget);
  } catch (err) {
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
 * The plan text comes from the referenced step's output (params.planFromStep),
 * which must resolve to a `.plan` or the block fails, and falls back to the
 * run's research plan only when no step is referenced. After unregistering the
 * run it parks the ticket in the backlog column with an awaiting-approval
 * label, mirroring the clarification exit: moving the ticket out of the AI
 * column is what stops the cron poll from re-dispatching it while it waits. A
 * later dashboard approval starts a fresh trigger_plan_approved run, whose
 * dispatch skips the column check so the ticket's backlog location does not
 * block it.
 */
export const execute: BlockExecuteFn = async (block, steps, ctx): Promise<BlockExecutionResult> => {
  const planFromStep =
    typeof block.params.planFromStep === "string" ? block.params.planFromStep.trim() : "";
  const planStep = planFromStep ? steps[planFromStep] : undefined;
  // Only planning_agent emits `.plan`. A planFromStep pointing anywhere else
  // must fail loud: silently approving ctx.researchPlanMarkdown would put a plan
  // in front of a human that the referenced block did not produce. The fallback
  // is for the no-reference case only.
  let markdown: string;
  if (planFromStep) {
    if (!planStep) {
      return {
        kind: "failed",
        output: { status: "failed" },
        reason: `planFromStep references block "${planFromStep}", which produced no output before this block ran`,
      };
    }
    if (typeof planStep.output.plan !== "string") {
      return {
        kind: "failed",
        output: { status: "failed" },
        reason: `planFromStep references block "${planFromStep}", whose output has no plan field; only a planning_agent block emits one`,
      };
    }
    markdown = planStep.output.plan;
  } else {
    markdown = ctx.researchPlanMarkdown;
  }
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

  const rawAssumptions = planStep?.output.assumptions;
  const assumptions = Array.isArray(rawAssumptions)
    ? rawAssumptions.filter((a): a is string => typeof a === "string")
    : [];

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
    ).catch(() => {});
  }

  await notifyPlanApprovalStep(ctx.ticket.identifier).catch(() => {});

  await ctx.unregisterBeforePr();
  await parkForApprovalStep(ctx.ticket.identifier, ctx.moveTargets.backlog);

  return { kind: "ended", output: { status: "awaiting_approval", approvalRequestId } };
};
