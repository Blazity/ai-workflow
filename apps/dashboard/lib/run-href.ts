import type { Run } from "@shared/contracts";

/**
 * Where opening a run navigates. A run with a ticket lands in that ticket's
 * view with the run selected (`?run=`) — the richer split: sibling runs + cost
 * rollup + the run's trace. A ticketless gate run has no ticket to group under,
 * so it falls back to the standalone trace page.
 */
export function runHref(run: Pick<Run, "id" | "ticket">): string {
  return run.ticket
    ? `/ticket/${encodeURIComponent(run.ticket)}?run=${encodeURIComponent(run.id)}`
    : `/trace/${encodeURIComponent(run.id)}`;
}
