/**
 * Work scope: a person's read of the durable record of which repositories a
 * subject's work may touch, and a person's edit of it.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export { answerAsWritten, recordRepositoryAnswer } from "./from-answer.js";
export type { RepositoryAnswerPersistence, RepositoryAnswerOutcome } from "./from-answer.js";
export {
  readRepositoryAnswerDeterministically,
  readRepositoryAnswerWithModel,
} from "./read-answer.js";
export type {
  AnswerReadingDeps,
  AnswerReadingModel,
  RepositoryQuestion,
} from "./read-answer.js";
export {
  applyConnectedWorkScopeEdit,
  applyWorkScopeEdit,
  readConnectedWorkScopeRecord,
  readWorkScopeRecord,
} from "./record.js";
export type {
  WorkScopeEditOutcome,
  WorkScopeEditor,
  WorkScopeRecordView,
} from "./record.js";
