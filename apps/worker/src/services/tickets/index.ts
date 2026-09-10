/**
 * Issue-tracker state: transitions, labels, move targets and AI-review routing.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
 */
export {
  isAiReviewDestination,
} from "./ai-review-destination.js";
export {
  PREMATURE_AI_REVIEW_CANCELLATION_REASON,
  decideAiReviewRun,
} from "./ai-review-transition.js";
export {
  AWAITING_APPROVAL_LABEL,
} from "./labels.js";
export {
  aiColumnMoveTarget,
} from "./move-targets.js";
export {
  updateTicketLabelsForRun,
} from "./ticket-label-mutation.js";
export {
  moveTicket,
  moveTicketForRun,
  withdrawTicketFromAiForRun,
} from "./ticket-transition.js";
export type {
  TicketTransitionOwner,
} from "./ticket-transition.js";
