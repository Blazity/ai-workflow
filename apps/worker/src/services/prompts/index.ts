/**
 * Prompt library service operations over the stored prompt records.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
 */
export {
  archivePrompt,
  createPrompt,
  findPromptUsage,
  findPromptUsageInPrompts,
  updatePromptMeta,
} from "./prompt-library-service.js";
