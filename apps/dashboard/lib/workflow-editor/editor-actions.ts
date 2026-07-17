export interface WorkflowEditorActionInput {
  dirty: boolean;
  structurallyValid: boolean;
  hasDraft: boolean;
  validationStatus: "checking" | "valid" | "invalid" | "error";
  validationIsCurrent: boolean;
}

export function workflowEditorActions(input: WorkflowEditorActionInput) {
  return {
    canSave: input.dirty && input.structurallyValid,
    canDeploy:
      !input.dirty &&
      input.structurallyValid &&
      input.hasDraft &&
      input.validationIsCurrent &&
      input.validationStatus === "valid",
  };
}
