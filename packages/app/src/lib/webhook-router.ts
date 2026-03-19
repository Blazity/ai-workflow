// packages/app/src/lib/webhook-router.ts
import { eq, and } from "drizzle-orm";
import {
  env,
  db,
  tickets,
  runAttempts,
  createLogger,
} from "@blazebot/shared";
import type { NormalizedEvent } from "@blazebot/shared";
import { implementTicket } from "../workflows/implementation.js";
import { reviewFixTicket } from "../workflows/review-fix.js";
import { startWorkflowRun, cancelWorkflowRun } from "./workflow-helpers.js";

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
      .onConflictDoNothing({ target: [tickets.externalId, tickets.source] })
      .returning();

    if (!created) {
      const rows = await db
        .select()
        .from(tickets)
        .where(
          and(eq(tickets.externalId, event.ticketId), eq(tickets.source, "jira")),
        );
      const dup = rows[0];
      if (dup?.workflowState === "queued" || dup?.workflowState === "implementing") {
        logger.info({ ticketId: event.ticketId, workflowState: dup.workflowState }, "duplicate_webhook_ignored");
        return;
      }
      logger.info({ ticketId: event.ticketId }, "duplicate_webhook_ignored");
      return;
    }

    await startWorkflowRun({
      ticketRowId: created.id,
      ticketExternalId: event.ticketId,
      type: "implementation",
      workflow: implementTicket,
      workflowArgs: [event.ticketId, "jira", event.triggeredBy],
      dedupeId: `impl-${event.ticketId}-${created.id}`,
    });
    return;
  }

  if (ticket.workflowState === "clarification_pending") {
    await db
      .update(tickets)
      .set({ workflowState: "queued", updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    await startWorkflowRun({
      ticketRowId: ticket.id,
      ticketExternalId: event.ticketId,
      type: "implementation",
      workflow: implementTicket,
      workflowArgs: [event.ticketId, "jira", event.triggeredBy],
      dedupeId: `impl-${event.ticketId}-${ticket.id}`,
    });
    return;
  }

  if (ticket.workflowState === "awaiting_review") {
    await db
      .update(tickets)
      .set({ workflowState: "queued", updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    await startWorkflowRun({
      ticketRowId: ticket.id,
      ticketExternalId: event.ticketId,
      type: "review_fix",
      workflow: reviewFixTicket,
      workflowArgs: [event.ticketId, "jira", event.triggeredBy],
      dedupeId: `fix-${event.ticketId}-${ticket.id}`,
    });
    return;
  }

  if (ticket.workflowState === "queued" || ticket.workflowState === "implementing") {
    logger.info({ ticketId: event.ticketId, workflowState: ticket.workflowState }, "duplicate_webhook_ignored");
    return;
  }

  if (ticket.workflowState === "failed") {
    await db
      .update(tickets)
      .set({ workflowState: "queued", updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    await startWorkflowRun({
      ticketRowId: ticket.id,
      ticketExternalId: event.ticketId,
      type: "implementation",
      workflow: implementTicket,
      workflowArgs: [event.ticketId, "jira", event.triggeredBy],
      dedupeId: `impl-${event.ticketId}-${ticket.id}`,
    });
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
    logger.info({ ticketId: event.ticketId, toColumn: event.toColumn }, "self_transition_ignored");
    return;
  }
  if (ticket.workflowState === "clarification_pending" && to === colBacklog) {
    logger.info({ ticketId: event.ticketId, toColumn: event.toColumn }, "self_transition_ignored");
    return;
  }

  logger.info(
    { ticketId: event.ticketId, fromColumn: event.fromColumn, toColumn: event.toColumn },
    "contradicting_webhook_received",
  );

  if (ticket.currentRunId) {
    const runRows = await db
      .select()
      .from(runAttempts)
      .where(eq(runAttempts.id, ticket.currentRunId));
    const activeRun = runRows[0];
    if (activeRun) {
      await cancelWorkflowRun({
        runAttemptId: activeRun.id,
        workflowRunId: activeRun.workflowRunId,
        containerId: activeRun.containerId,
        ticketExternalId: event.ticketId,
      });
    }
  }

  await db
    .update(tickets)
    .set({
      workflowState: "failed",
      state: event.toColumn,
      currentRunId: null,
      updatedAt: new Date(),
    })
    .where(eq(tickets.id, ticket.id));

  logger.info(
    { ticketId: event.ticketId, from: ticket.workflowState, to: "failed" },
    "ticket_state_transition",
  );
}
