/**
 * Agent memory: what the dashboard may read of what the agent remembered, and what it may erase.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  MAX_MEMORY_KEY_LENGTH,
  eraseMemoryDocument,
  isUsableMemoryKeyPart,
  listMemoryDocumentSummaries,
  readMemoryDocument,
} from "./memory-documents.js";
