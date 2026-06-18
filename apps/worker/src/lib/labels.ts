/**
 * Issue-tracker label the workflow attaches when it asks a human for
 * clarification (and moves the ticket to the backlog column). The overview's
 * awaiting-input scan filters on this label so it only inspects tickets the
 * bot actually paused on, and the workflow removes it again when the ticket is
 * re-picked into the AI column.
 */
export const NEEDS_CLARIFICATION_LABEL = "needs-clarification";
