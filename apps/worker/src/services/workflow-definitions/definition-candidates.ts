/**
 * The editor's questions about a candidate graph it holds but has not saved.
 *
 * None of these writes anything. They exist because the editor asks the same
 * things of an unsaved graph that the store asks of a saved one, and the answers
 * have to come from the same schema and the same block registry, so an operator
 * is never told a graph is fine and then refused on save.
 */
import type {
  WorkflowDefinitionCatalogResponse,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import { analyzeWorkflowV2Catalog } from "../../workflow-definition/available-values.js";
import { currentBlockContracts } from "./block-contracts.js";
import { validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring } from "./policy-operations.js";
import {
  describeWorkflowDefinitionIssues,
  workflowDefinitionV2Schema,
} from "../../workflow-definition/schema.js";
import { declaresRetiredSchema } from "../../workflow-definition/validation.js";

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
  const parsed = workflowDefinitionV2Schema.safeParse(candidate);
  if (parsed.success) return { ok: true, definition: parsed.data as WorkflowDefinitionV2 };
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
 *  from. Pure apart from the registry, which is a deployment fact. */
export function analyzeWorkflowDefinitionCatalog(
  definition: WorkflowDefinitionV2,
): WorkflowDefinitionCatalogResponse {
  return analyzeWorkflowV2Catalog(definition, currentBlockContracts().resolveContract);
}
