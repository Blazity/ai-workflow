import { eq, and } from "drizzle-orm";
import { env } from "../env.js";
import { db } from "../db.js";
import { tickets } from "../schema.js";
import { ticketQueue } from "../queue.js";
import { teardownContainer } from "../sandbox/manager.js";
import type { NormalizedEvent } from "./types.js";

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
  const aiColumns = [
    normalize(env.COLUMN_AI),
    normalize(env.COLUMN_AI_REVIEW),
  ];
  return aiColumns.includes(col);
}

async function handleMovedToAi(event: NormalizedEvent): Promise<void> {
  const existing = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.externalId, event.ticketId),
        eq(tickets.source, "jira"),
      ),
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
    return;
  }

  if (ticket.workflowState === "queued" || ticket.workflowState === "implementing") {
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
    return;
  }
}

async function handleMovedOutOfAi(event: NormalizedEvent): Promise<void> {
  const existing = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.externalId, event.ticketId),
        eq(tickets.source, "jira"),
      ),
    );

  const ticket = existing[0];
  if (!ticket) return;

  const jobId = ticket.workflowState === "awaiting_review"
    ? `fix-${event.ticketId}-${ticket.id}`
    : `impl-${event.ticketId}-${ticket.id}`;

  try {
    const job = await ticketQueue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === "waiting" || state === "delayed") {
        await job.remove();
      }
    }
  } catch {
    /* best effort — job may already be processing */
  }

  if (ticket.currentRunId) {
    const runRows = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticket.id));
    const currentRun = runRows[0];
    if (currentRun?.currentRunId) {
      try {
        await teardownContainer(currentRun.currentRunId);
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
}
