import { eq, and } from "drizzle-orm";
import { env } from "../env.js";
import { db } from "../db.js";
import { tickets } from "../schema.js";
import { ticketQueue } from "../queue.js";
import type { NormalizedEvent } from "./types.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function routeTicketTransition(
  event: NormalizedEvent,
): Promise<void> {
  const to = normalize(event.toColumn);
  const colAi = normalize(env.COLUMN_AI);

  if (to !== colAi) {
    return;
  }

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
}
