import { env } from "../../env.js";
import type { TicketTransitionEvent } from "./types.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function routeTicketTransition(event: TicketTransitionEvent): void {
  const from = normalize(event.fromColumn);
  const to = normalize(event.toColumn);

  const colAi = normalize(env.COLUMN_AI);
  const colInProgress = normalize(env.COLUMN_AI_IN_PROGRESS);
  const colReview = normalize(env.COLUMN_AI_REVIEW);
  const colBacklog = normalize(env.COLUMN_BACKLOG);

  if (to === colAi) {
    console.log(`TODO: start new work for ticket ${event.externalTicketId}`);
    return;
  }

  if (to === colInProgress && from === colReview) {
    console.log(
      `TODO: pick up review comments for ticket ${event.externalTicketId}`,
    );
    return;
  }

  if (to === colInProgress && from === colBacklog) {
    console.log(
      `TODO: getting ticket ${event.externalTicketId} with recent specs`,
    );
    return;
  }

  if (from === colInProgress) {
    console.log(
      `TODO: cancel active agent run for ticket ${event.externalTicketId}`,
    );
    return;
  }

  // Transition not relevant to Blazebot — ignore
}
