import { z } from "zod";
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

/**
 * send_plan_approval: file the run's plan for human approval, then end the run
 * without moving the ticket. The plan text comes from the referenced step's
 * output (params.planFromStep) or the run's research plan. unregisterBeforePr
 * only drops the run-registry entry, so the ticket stays in the AI column and a
 * later dashboard approval can start a fresh trigger_plan_approved run.
 */
export const execute: BlockExecuteFn = async (block, steps, ctx): Promise<BlockExecutionResult> => {
  const planFromStep =
    typeof block.params.planFromStep === "string" ? block.params.planFromStep.trim() : "";
  const planStep = planFromStep ? steps[planFromStep] : undefined;
  const candidate = planStep?.output.plan;
  const markdown = typeof candidate === "string" ? candidate : ctx.researchPlanMarkdown;
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

  return { kind: "ended", output: { status: "awaiting_approval", approvalRequestId } };
};
