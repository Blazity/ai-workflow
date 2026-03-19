import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { db, runAttempts, tickets, createLogger } from "@blazebot/shared";
import { teardownContainer } from "../sandbox/manager.js";

const logger = createLogger();

/**
 * Create a run_attempts row, start the workflow, and store the workflow run ID.
 * Appends the run_attempts ID as the last workflow argument automatically.
 */
export async function startWorkflowRun(options: {
  ticketRowId: string;
  ticketExternalId: string;
  type: "implementation" | "review_fix";
  branchName?: string;
  workflow: (...args: any[]) => any;
  workflowArgs: any[];
  dedupeId: string;
}): Promise<string> {
  const [run] = await db
    .insert(runAttempts)
    .values({
      ticketId: options.ticketRowId,
      type: options.type,
      status: "pending",
      branchName: options.branchName,
    })
    .returning();

  await db
    .update(tickets)
    .set({ currentRunId: run!.id, updatedAt: new Date() })
    .where(eq(tickets.id, options.ticketRowId));

  const handle = await start(options.workflow, [...options.workflowArgs, run!.id], {
    id: options.dedupeId,
  });

  await db
    .update(runAttempts)
    .set({ workflowRunId: handle.runId })
    .where(eq(runAttempts.id, run!.id));

  logger.info(
    {
      ticketId: options.ticketExternalId,
      runAttemptId: run!.id,
      workflowRunId: handle.runId,
      type: options.type,
    },
    "workflow_run_started",
  );

  return run!.id;
}

/**
 * Cancel an active workflow run: cancel at the framework level, teardown
 * the container, and update the run_attempts record.
 */
export async function cancelWorkflowRun(options: {
  runAttemptId: string;
  workflowRunId: string | null;
  containerId: string | null;
  ticketExternalId: string;
}): Promise<void> {
  // 1. Cancel at the workflow framework level
  if (options.workflowRunId) {
    try {
      const world = getWorld();
      await world.events.create(options.workflowRunId, {
        eventType: "run_cancelled",
        specVersion: 2,
      });
      logger.info(
        { ticketId: options.ticketExternalId, workflowRunId: options.workflowRunId },
        "workflow_run_cancelled",
      );
    } catch (err) {
      // Run may already be in a terminal state — log and continue
      logger.warn(
        {
          ticketId: options.ticketExternalId,
          workflowRunId: options.workflowRunId,
          error: (err as Error).message,
        },
        "workflow_cancel_failed",
      );
    }
  }

  // 2. Teardown the container
  if (options.containerId) {
    try {
      await teardownContainer(options.containerId);
      logger.info(
        { ticketId: options.ticketExternalId, containerId: options.containerId },
        "container_teardown_direct",
      );
    } catch (err) {
      logger.warn(
        {
          ticketId: options.ticketExternalId,
          containerId: options.containerId,
          error: (err as Error).message,
        },
        "container_teardown_failed",
      );
    }
  }

  // 3. Update the run_attempts record
  await db
    .update(runAttempts)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(runAttempts.id, options.runAttemptId));
}
