/**
 * What one block's prompt would render to, for a candidate the editor holds.
 *
 * Its own module rather than a function next to the other candidate questions,
 * because rendering a prompt reaches the repository instruction sources, and
 * that module carries a `"use step"` function. Validating or cataloguing a
 * candidate must not load a step: those answers are wanted while the editor
 * types, and the route that asks for them had no step in its graph before the
 * services tier existed.
 */
import { getDb } from "../../db/client.js";
import { workflowBlockRegistryContextFromEnv } from "../../workflow-definition/models.js";
import {
  previewWorkflowPromptCandidate,
  type WorkflowPromptPreviewResult,
} from "../../workflow-definition/prompt-preview.js";

export function previewWorkflowDefinitionPrompt(input: {
  candidate: unknown;
  blockId: string;
  organizationId?: string;
}): Promise<WorkflowPromptPreviewResult> {
  return previewWorkflowPromptCandidate(
    getDb(),
    input.candidate,
    input.blockId,
    workflowBlockRegistryContextFromEnv(),
    { organizationId: input.organizationId },
  );
}
