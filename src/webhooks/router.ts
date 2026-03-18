import { eq, and } from "drizzle-orm";
import { env } from "../env.js";
import { db } from "../db.js";
import { tickets, runAttempts } from "../schema.js";
import { ticketQueue } from "../queue.js";
import { teardownContainer } from "../sandbox/manager.js";
import { createLogger } from "../logger.js";
import type { NormalizedEvent } from "./types.js";

const logger = createLogger();

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function routeTicketTransition(
  event: NormalizedEvent,
): Promise<void> {
  const to = normalize(event.toColumn);
  const from = normalize(event.fromColumn);
  const colAi = normalize(env.COLUMN_AI);

  if (to === colAi) {
    await handleMovedToAi(event);
    return;
  }

  if (from === colAi || isAiRelatedColumn(from)) {
    await handleMovedOutOfAi(event);
    return;
  }
}

function isAiRelatedColumn(col: string): boolean {
  const aiColumns = [normalize(env.COLUMN_AI), normalize(env.COLUMN_AI_REVIEW)];
  return aiColumns.includes(col);
}

async function handleMovedToAi(event: NormalizedEvent): Promise<void> {
  logger.info(
    {
      ticketId: event.ticketId,
      fromColumn: event.fromColumn,
      toColumn: event.toColumn,
      triggeredBy: event.triggeredBy,
    },
    "webhook_received",
  );

  const existing = await db
    .select()
    .from(tickets)
    .where(
      and(eq(tickets.externalId, event.ticketId), eq(tickets.source, "jira")),
    );

  const ticket = existing[0];

  if (!ticket) {
    const [created] = await db
      .insert(tickets)
      .values({
        externalId: event.ticketId,
        identifier: event.ticketId,
        source: "jira",
        state: event.toColumn,
        workflowState: "queued",
        assignee: event.triggeredBy,
      })
      .returning();

    await ticketQueue.add(
      "implementation",
      {
        type: "implementation",
        ticketId: event.ticketId,
        source: "jira",
        triggeredBy: event.triggeredBy,
      },
      { jobId: `impl-${event.ticketId}-${created!.id}` },
    );
    logger.info(
      { ticketId: event.ticketId, jobType: "implementation" },
      "job_enqueued",
    );
    return;
  }

  if (ticket.workflowState === "clarification_pending") {
    await db
      .update(tickets)
      .set({ workflowState: "queued", updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    await ticketQueue.add(
      "implementation",
      {
        type: "implementation",
        ticketId: event.ticketId,
        source: "jira",
        triggeredBy: event.triggeredBy,
      },
      { jobId: `impl-${event.ticketId}-${ticket.id}` },
    );
    logger.info(
      { ticketId: event.ticketId, jobType: "implementation" },
      "job_enqueued",
    );
    return;
  }

  if (ticket.workflowState === "awaiting_review") {
    await db
      .update(tickets)
      .set({ workflowState: "queued", updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    await ticketQueue.add(
      "review_fix",
      {
        type: "review_fix",
        ticketId: event.ticketId,
        source: "jira",
        triggeredBy: event.triggeredBy,
      },
      { jobId: `fix-${event.ticketId}-${ticket.id}` },
    );
    logger.info(
      { ticketId: event.ticketId, jobType: "review_fix" },
      "job_enqueued",
    );
    return;
  }

  if (
    ticket.workflowState === "queued" ||
    ticket.workflowState === "implementing"
  ) {
    logger.info(
      { ticketId: event.ticketId, workflowState: ticket.workflowState },
      "duplicate_webhook_ignored",
    );
    return;
  }

  if (ticket.workflowState === "failed") {
    await db
      .update(tickets)
      .set({ workflowState: "queued", updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    await ticketQueue.add(
      "implementation",
      {
        type: "implementation",
        ticketId: event.ticketId,
        source: "jira",
        triggeredBy: event.triggeredBy,
      },
      { jobId: `impl-${event.ticketId}-${ticket.id}-${Date.now()}` },
    );
    logger.info(
      { ticketId: event.ticketId, jobType: "implementation" },
      "job_enqueued",
    );
    return;
  }
}

async function handleMovedOutOfAi(event: NormalizedEvent): Promise<void> {
  const existing = await db
    .select()
    .from(tickets)
    .where(
      and(eq(tickets.externalId, event.ticketId), eq(tickets.source, "jira")),
    );

  const ticket = existing[0];
  if (!ticket) return;

  const to = normalize(event.toColumn);
  const colAiReview = normalize(env.COLUMN_AI_REVIEW);
  const colBacklog = normalize(env.COLUMN_BACKLOG);

  if (ticket.workflowState === "awaiting_review" && to === colAiReview) {
    logger.info(
      { ticketId: event.ticketId, toColumn: event.toColumn },
      "self_transition_ignored",
    );
    return;
  }
  if (ticket.workflowState === "clarification_pending" && to === colBacklog) {
    logger.info(
      { ticketId: event.ticketId, toColumn: event.toColumn },
      "self_transition_ignored",
    );
    return;
  }

  logger.info(
    {
      ticketId: event.ticketId,
      fromColumn: event.fromColumn,
      toColumn: event.toColumn,
    },
    "contradicting_webhook_received",
  );

  const jobId =
    ticket.workflowState === "awaiting_review"
      ? `fix-${event.ticketId}-${ticket.id}`
      : `impl-${event.ticketId}-${ticket.id}`;

  try {
    const job = await ticketQueue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === "waiting" || state === "delayed") {
        await job.remove();
        logger.info(
          { ticketId: event.ticketId, jobId },
          "pending_job_cancelled",
        );
      }
    }
  } catch {
    /* best effort — job may already be processing */
  }

  if (ticket.currentRunId) {
    const runRows = await db
      .select()
      .from(runAttempts)
      .where(eq(runAttempts.id, ticket.currentRunId));
    const activeRun = runRows[0];
    if (activeRun?.containerId) {
      try {
        await teardownContainer(activeRun.containerId);
        logger.info(
          { ticketId: event.ticketId, containerId: activeRun.containerId },
          "container_teardown",
        );
      } catch {
        /* best effort */
      }
    }
  }

  await db
    .update(tickets)
    .set({
      workflowState: "failed",
      state: event.toColumn,
      updatedAt: new Date(),
    })
    .where(eq(tickets.id, ticket.id));

  logger.info(
    { ticketId: event.ticketId, from: ticket.workflowState, to: "failed" },
    "ticket_state_transition",
  );
}
