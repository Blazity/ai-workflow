/**
 * Issue-tracker label the workflow attaches when it asks a human for
 * clarification (and moves the ticket to the backlog column). The overview's
 * awaiting-input scan filters on this label so it only inspects tickets the
 * bot actually paused on, and the workflow removes it again when the ticket is
 * re-picked into the AI column.
 */
export const NEEDS_CLARIFICATION_LABEL = "needs-clarification";

/**
 * Label prefix + builder for the run-id tag the dispatcher attaches to a ticket
 * when it starts a workflow. The dashboard reads these back to map a ticket to
 * the run(s) that processed it (see overview/collect-runs). Labels accumulate
 * (add-only), so a re-processed ticket carries one `run:<id>` label per run.
 */
export const RUN_LABEL_PREFIX = "run:";
export const runLabel = (runId: string): string =>
  `${RUN_LABEL_PREFIX}${runId}`;
