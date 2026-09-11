/**
 * Prompt library service operations over the stored prompt records.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  archivePrompt,
  createPrompt,
  findPromptUsage,
  findPromptUsageInPrompts,
  updatePromptMeta,
  requirePromptLibraryEditRole,
  saveConnectedPromptVersionWithPolicy,
  savePromptVersionWithPolicy,
} from "./prompt-library-service.js";
export {
  MAX_PROMPT_INT4,
  isStorablePromptId,
  isStorablePromptVersion,
} from "./prompt-library-identifiers.js";
export {
  promptLibraryFailure,
  PromptLibraryStoreError,
} from "./prompt-library-failures.js";
export type {
  PromptLibraryFailure,
} from "./prompt-library-failures.js";
export {
  listPromptLibrary,
  readPromptDetail,
  readPromptUsage,
  readPromptVersion,
} from "./prompt-library-reads.js";
export {
  archivePromptEntry,
  createPromptEntry,
  restorePromptEntryVersion,
  savePromptEntryVersion,
  updatePromptEntryMeta,
} from "./prompt-library-writes.js";
export type {
  PromptLibraryWriter,
} from "./prompt-library-writes.js";
export {
  PROMPT_BODY_MAX_LENGTH,
  validatePromptBody,
} from "./prompt-library-validation.js";
