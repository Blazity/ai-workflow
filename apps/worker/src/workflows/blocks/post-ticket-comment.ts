import { z } from "zod";
import type { ActiveRunOwner } from "../../lib/active-run-owner.js";
import { isRunControlError } from "../run-control-error.js";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    body: z.string().trim().max(8000).optional(),
  })
  .strict();

async function blockPostTicketCommentStep(
  ticketId: string,
  body: string,
  owner: ActiveRunOwner,
): Promise<string | null> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await import("../../lib/active-run-owner.js");
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  await assertActiveRunOwner(getDb(), owner);
  return issueTracker.postComment(ticketId, body);
}
blockPostTicketCommentStep.maxRetries = 0;

/**
 * post_ticket_comment: post the body param as a comment on the run's ticket.
 * Returns the deep-linkable comment URL when the tracker exposes one.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs = {},
): Promise<BlockExecutionResult> => {
  const body =
    typeof resolvedInputs.body === "string"
      ? resolvedInputs.body.trim()
      : typeof block.params.body === "string"
        ? block.params.body.trim()
        : "";
  if (body.length === 0) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: "post_ticket_comment requires a body",
    };
  }

  try {
    const commentUrl = await blockPostTicketCommentStep(ctx.ticket.identifier, body, {
      subjectKey: ctx.entry.subjectKey,
      ownerToken: ctx.entry.ownerToken,
      runId: ctx.runId,
    });
    return { kind: "next", output: { status: "ok", commentUrl } };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};
