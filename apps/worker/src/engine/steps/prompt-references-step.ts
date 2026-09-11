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
  const { createConnectedPromptReferenceLoader } = await import(
    "../../prompt-library/prompt-reference-loader.js"
  );
  return resolvePromptReferencesInNodes(
    nodes,
    createConnectedPromptReferenceLoader(),
    { requirePinned: true },
  );
}
resolvePromptReferencesForRun.maxRetries = 0;
