import { z } from "zod";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    body: z.string().trim().min(1).max(8000),
  })
  .strict();

async function blockPostTicketCommentStep(
  ticketId: string,
  body: string,
): Promise<string | null> {
  "use step";
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  return issueTracker.postComment(ticketId, body);
}
blockPostTicketCommentStep.maxRetries = 0;

/**
 * post_ticket_comment: post the body param as a comment on the run's ticket.
 * Returns the deep-linkable comment URL when the tracker exposes one.
 */
export const execute: BlockExecuteFn = async (block, _steps, ctx): Promise<BlockExecutionResult> => {
  const body = typeof block.params.body === "string" ? block.params.body.trim() : "";
  if (body.length === 0) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: "post_ticket_comment requires a body",
    };
  }

  try {
    const commentUrl = await blockPostTicketCommentStep(ctx.ticket.identifier, body);
    return { kind: "next", output: { status: "ok", commentUrl } };
  } catch (err) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};
