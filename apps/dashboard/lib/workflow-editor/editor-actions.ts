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
