import type { WorkflowDefinitionNode } from "@shared/contracts";
import {
  resolvePromptReferencesInNodes,
  type ResolvedWorkflowPromptReferences,
} from "@shared/prompts";

export { resolvePromptReferencesInNodes } from "@shared/prompts";

export async function resolvePromptReferencesForRun(
  nodes: WorkflowDefinitionNode[],
): Promise<ResolvedWorkflowPromptReferences> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { createPromptReferenceLoader } = await import(
    "../../prompt-library/prompt-reference-loader.js"
  );
  const db = getDb();

  return resolvePromptReferencesInNodes(
    nodes,
    createPromptReferenceLoader(db),
    { requirePinned: true },
  );
}
resolvePromptReferencesForRun.maxRetries = 0;
