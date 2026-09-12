/**
 * The editor's questions about a candidate graph it holds but has not saved.
 *
 * None of these writes anything. They exist because the editor asks the same
 * things of an unsaved graph that the store asks of a saved one, and the answers
 * have to come from the same schema and the same block registry, so an operator
 * is never told a graph is fine and then refused on save.
 */
import type {
  SettingsSnapshot,
  WorkflowDefinitionCatalogResponse,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import { blockContractsFor } from "./block-contracts.js";
import { validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring } from "./policy-operations.js";
import {
  analyzeWorkflowV2Catalog,
  declaresRetiredSchema,
  describeWorkflowDefinitionIssues,
  parse,
} from "@shared/workflow-graph";

export type WorkflowDefinitionCandidateParse =
  | { ok: true; definition: WorkflowDefinitionV2 }
  | { ok: false; message: string };

/**
 * Is this candidate a v2 definition?
 *
 * A candidate that declares the retired v1 schema is reported as retired rather
 * than as malformed, because the two mean different things to an operator: one
 * is a graph to fix, the other is a graph this system will never accept again.
 */
export function parseWorkflowDefinitionCandidate(
  candidate: unknown,
): WorkflowDefinitionCandidateParse {
  const parsed = parse(candidate);
  if (parsed.definition !== null) return { ok: true, definition: parsed.definition };
  return {
    ok: false,
    message: declaresRetiredSchema(candidate)
      ? RETIRED_SCHEMA_MESSAGE
      : `Invalid definition: ${describeWorkflowDefinitionIssues(parsed.error)}`,
  };
}

/** Validate a candidate the editor holds but has not saved. An unparseable
 *  candidate is a validation result, not a bad request: the editor renders the
 *  issues in the same panel either way. */
export async function validateWorkflowDefinitionDraftCandidate(candidate: unknown) {
  const validation = await validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring(candidate);
  return validation.response;
}

/** Which values every block in this candidate may read, and where each comes
 *  from. Pure apart from the registry, which is a deployment fact: the caller
 *  hands in the snapshot its request loaded, so the block contracts resolve
 *  against the operator's stored defaults rather than the process environment. */
export function analyzeWorkflowDefinitionCatalog(
  settings: SettingsSnapshot,
  definition: WorkflowDefinitionV2,
): WorkflowDefinitionCatalogResponse {
  return analyzeWorkflowV2Catalog(blockContractsFor(settings).analyzeValues(definition));
}
