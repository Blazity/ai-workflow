/**
 * Issue-tracker label the workflow attaches when it asks a human for
 * clarification (and moves the ticket to the backlog column). The overview's
 * awaiting-input scan filters on this label so it only inspects tickets the
 * bot actually paused on, and the workflow removes it again when the ticket is
 * re-picked into the AI column.
 */
export const NEEDS_CLARIFICATION_LABEL = "needs-clarification";

/**
 * Issue-tracker label the workflow attaches when send_plan_approval files a plan
 * for human approval (and moves the ticket to the backlog column). Mirrors the
 * clarification pattern: moving the ticket out of the AI column is what keeps
 * the cron poll from re-dispatching it, and this label marks why the ticket is
 * parked so the paused state is distinguishable from a clarification.
 */
export const AWAITING_APPROVAL_LABEL = "awaiting-approval";
