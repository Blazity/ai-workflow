import { logger } from "./logger.js";

/**
 * A terminal Workflow run may still have a step handler executing. Do not
 * release or park the application owner until every durable step page proves
 * that no handler remains in `running`.
 */
export async function confirmWorkflowStepsDrained(
  subjectKey: string,
  runId: string,
): Promise<boolean> {
  try {
    const { getWorld } = await import("workflow/runtime");
    const world = getWorld();
    let cursor: string | undefined;
    for (;;) {
      const page = await world.steps.list({
        runId,
        resolveData: "none",
        pagination: { limit: 100, ...(cursor ? { cursor } : {}) },
      });
      if (page.data.some((step) => step.status === "running")) {
        logger.info({ subjectKey, runId }, "workflow_step_drain_pending");
        return false;
      }
      if (!page.hasMore) return true;
      if (!page.cursor) {
        throw new Error("Workflow step pagination reported more pages without a cursor");
      }
      cursor = page.cursor;
    }
  } catch (error) {
    logger.warn(
      { subjectKey, runId, error: (error as Error).message },
      "workflow_step_drain_unconfirmed",
    );
    return false;
  }
}
