/**
 * Clarification lifecycle outside its store: answering, resuming, expiry and comment formatting.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
 */
export {
  MAX_ANSWER_LENGTH,
  answerClarificationAndResume,
  retireClarificationForGoneTicket,
} from "./answer-core.js";
export type {
  AnswerClarificationOutcome,
} from "./answer-core.js";
export {
  expireHookClarifications,
} from "./expiry.js";
export {
  resumeClarificationFromComments,
} from "./resume-from-comments.js";
