import type { ReviewWorkflowArgs } from "../workflows/review.js";

export async function dispatchReview(args: ReviewWorkflowArgs): Promise<{ runId: string }> {
  const { start } = await import("workflow/api");
  const { reviewWorkflow } = await import("../workflows/review.js");
  const run = await start(reviewWorkflow, [args]);
  return { runId: run.runId };
}
