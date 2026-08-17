export interface WorkflowEditorActionInput {
  dirty: boolean;
  structurallyValid: boolean;
  hasDraft: boolean;
}

export function workflowEditorActions(input: WorkflowEditorActionInput) {
  return {
    canSave: input.dirty && input.structurallyValid,
    // Deploy performs an immediate authoritative validation. Cached background
    // validation may be stale and must never decide whether the action is
    // available.
    canDeploy: input.structurallyValid && (input.dirty || input.hasDraft),
  };
}

/**
 * Independent of the canvas "dirty" flag (canvas vs. saved draft): a rollback
 * changes what is deployed without ever touching the saved draft, so the
 * draft can look saved (canvas matches it) while no longer matching what is
 * live. Either key being absent (no draft yet, or nothing deployed yet) means
 * there is nothing to compare, so it reports no divergence.
 */
export function draftDiffersFromDeployed(
  draftSemanticKey: string | null,
  deployedSemanticKey: string | null,
): boolean {
  return (
    draftSemanticKey !== null &&
    deployedSemanticKey !== null &&
    draftSemanticKey !== deployedSemanticKey
  );
}

export type WorkflowDeploymentSaveDecision =
  | { kind: "ready"; validation: WorkflowDefinitionValidationResponse }
  | { kind: "invalid"; validation: WorkflowDefinitionValidationResponse }
  | { kind: "unavailable"; message: string };

/**
 * A dirty deploy is validated twice by design. The validation returned with
 * the saved immutable snapshot is authoritative over the earlier candidate
 * check because it is the exact version the deployment endpoint will select.
 */
export function workflowDeploymentAfterSave(
  _immediateValidation: WorkflowDefinitionValidationResponse,
  saved: WorkflowDefinitionSaveResponse,
): WorkflowDeploymentSaveDecision {
  if (!saved.validation) {
    return {
      kind: "unavailable",
      message: saved.validationError ?? "Unable to validate the saved draft",
    };
  }
  return saved.validation.valid
    ? { kind: "ready", validation: saved.validation }
    : { kind: "invalid", validation: saved.validation };
}
import type {
  WorkflowDefinitionSaveResponse,
  WorkflowDefinitionValidationResponse,
} from "@shared/contracts";
