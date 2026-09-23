import type { RelatedTicket } from "../adapters/issue-tracker/types.js";

/**
 * How many related tickets one prompt lists. A parent with a few dozen
 * subtasks is a real board, and each line is a key, a status and a title, so
 * this is room for the whole of an ordinary plan while a ticket linked to
 * hundreds of others still costs a prompt a bounded amount.
 */
const MAX_RELATED_TICKETS_SHOWN = 25;

export interface RelatedTicketsView {
  /** The first ones, in the order the tracker gave them (parent, children,
   *  links), so a cut drops links before it drops a subtask. */
  shown: RelatedTicket[];
  /** How many were left out, for the prompt to say so. */
  omitted: number;
}

/**
 * What every prompt shows of a ticket's related tickets. One function, so the
 * discovery pass and the planning pass that follows it see the same list and
 * the same count of what was cut. Null when the tracker did not report any
 * (absent means not read, which says nothing either way).
 */
export function boundRelatedTickets(
  related: readonly RelatedTicket[] | undefined,
): RelatedTicketsView | null {
  if (!Array.isArray(related)) return null;
  return {
    shown: related.slice(0, MAX_RELATED_TICKETS_SHOWN),
    omitted: Math.max(0, related.length - MAX_RELATED_TICKETS_SHOWN),
  };
}
