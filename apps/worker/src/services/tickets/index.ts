/**
 * Issue-tracker state: transitions, labels, move targets and AI-review routing.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  isAiReviewDestination,
} from "./ai-review-destination.js";
export { aiColumnMoveTarget } from "./move-targets.js";
export {
  PREMATURE_AI_REVIEW_CANCELLATION_REASON,
  decideAiReviewRun,
} from "./ai-review-transition.js";
export {
  updateTicketLabelsForRun,
} from "./ticket-label-mutation.js";
export {
  listTicketRuns,
  ticketKeyFromPathSegment,
} from "./ticket-runs-read.js";
export type {
  TicketRunsPayload,
} from "./ticket-runs-read.js";
export {
  moveTicket,
  moveTicketForRun,
  withdrawTicketFromAiForRun,
} from "./ticket-transition.js";
export type {
  TicketTransitionOwner,
} from "./ticket-transition.js";
