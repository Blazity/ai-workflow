import type {
  WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import { createPromptReferenceLoader } from "../prompt-library/store.js";
import {
  exampleValueForJsonSchema,
  resolveProfileInstructions,
  type EffectivePromptCompilation,
} from "../workflows/effective-prompt.js";
import { unresolvedRepositoryInstructionSources } from "../workflows/repository-instructions.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import {
  isPromptAuthoringBlock,
  resolveNodePromptAuthoring,
} from "./prompt-authoring.js";
import { validateWorkflowDefinitionCandidate } from "./validation.js";

export interface WorkflowPromptPreview {
  blockId: string;
  prompt: string;
  hash: string;
  sections: EffectivePromptCompilation["sections"];
  provenance: EffectivePromptCompilation["provenance"];
  unresolvedSources: EffectivePromptCompilation["unresolvedSources"];
  issues: WorkflowDefinitionValidationIssue[];
}

export type WorkflowPromptPreviewResult =
  | { ok: true; preview: WorkflowPromptPreview }
  | { ok: false; statusCode: 400 | 422; message: string; issues: WorkflowDefinitionValidationIssue[] };

/**
 * Compiles one block from the exact unsaved candidate supplied by the editor.
 * It intentionally does not read the stored draft; the definition id route is
 * only the authenticated organization-scoped parent resource.
 */
export async function previewWorkflowPromptCandidate(
  db: Db,
  candidate: unknown,
  blockId: string,
  registryContext: WorkflowBlockRegistryContext,
): Promise<WorkflowPromptPreviewResult> {
  const validated = validateWorkflowDefinitionCandidate(
    candidate,
    registryContext,
  );
  if (validated.parsed?.schemaVersion !== 2) {
    return {
      ok: false,
      statusCode: 422,
      message: "Prompt preview requires a structurally valid v2 definition.",
      issues: validated.response.issues,
    };
  }
  const nodeIndex = validated.parsed.nodes.findIndex(
    (node) => node.id === blockId,
  );
  const node = validated.parsed.nodes[nodeIndex];
  if (!node) {
    return {
      ok: false,
      statusCode: 400,
      message: `Unknown block "${blockId}".`,
      issues: [],
    };
  }
  if (!isPromptAuthoringBlock(node)) {
    return {
      ok: false,
      statusCode: 400,
      message: `Block "${blockId}" does not have an effective agent prompt.`,
      issues: [],
    };
  }

  const availableValues =
    validated.response.availableValuesByNode[node.id] ?? [];
  const profileSource = await resolveProfileInstructions({
    node,
    defaultProvider: registryContext.defaultAgent.provider,
  });
  const resolved = await resolveNodePromptAuthoring({
    node,
    nodeIndex,
    availableValues,
    loadPromptReference: createPromptReferenceLoader(db),
    profileSource,
    unresolvedRepositorySources: unresolvedRepositoryInstructionSources(),
    runtimeData: renderPreviewRuntimeData(availableValues),
  });
  const validationIssues = validated.response.issues.filter(
    (issue) => issue.nodeId === null || issue.nodeId === blockId,
  );
  return {
    ok: true,
    preview: {
      blockId,
      prompt: resolved.compilation.prompt,
      hash: resolved.compilation.hash,
      sections: resolved.compilation.sections,
      provenance: resolved.compilation.provenance,
      unresolvedSources: resolved.compilation.unresolvedSources,
      issues: dedupeIssues([...validationIssues, ...resolved.issues]),
    },
  };
}

function renderPreviewRuntimeData(
  values: Parameters<typeof resolveNodePromptAuthoring>[0]["availableValues"],
): string {
  if (values.length === 0) {
    return "No runtime values are guaranteed for this block.";
  }
  return JSON.stringify(
    Object.fromEntries(
      values.map((value) => [
        value.reference,
        exampleValueForJsonSchema(value.schema),
      ]),
    ),
    null,
    2,
  );
}

function dedupeIssues(
  issues: readonly WorkflowDefinitionValidationIssue[],
): WorkflowDefinitionValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify([
      issue.code,
      issue.nodeId,
      issue.path ?? null,
      issue.message,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
