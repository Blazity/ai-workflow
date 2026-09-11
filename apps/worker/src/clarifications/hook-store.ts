/** Compatibility exports for callers that have not yet moved to the DB domain. */
export {
  answerHookClarification,
  getHookClarification,
  getResumeFailedClarificationForRun,
  getResumableClarificationForRun,
  getResumableClarificationForTicket,
  markHookClarificationCleanup,
  prepareHookClarification,
  publishHookClarification,
  recordHookClarificationSnapshot,
  supersedePreparingHookClarification,
  type HookClarificationRow,
} from "../db/repositories/clarification-hooks.js";
