/**
 * Clarification lifecycle outside its store: answering, resuming, expiry and comment formatting.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
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
  answerClarificationRequest,
} from "./answer-request.js";
export type {
  AnswerClarificationRequestOutcome,
} from "./answer-request.js";
export {
  expireHookClarifications,
} from "./expiry.js";
export {
  resumeClarificationFromComments,
} from "./resume-from-comments.js";
