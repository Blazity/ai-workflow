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
} from "./prompt-library-service.js";
