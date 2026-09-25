export interface WorkflowEditorActionInput {
  dirty: boolean;
  structurallyValid: boolean;
  hasDraft: boolean;
  /**
   * The deployed version the saved draft is identical to, or null when the
   * draft differs from what is deployed (or either is missing). A saved draft
   * that is already live is nothing to deploy.
   */
  draftDeployedAs: number | null;
}

export function workflowEditorActions(input: WorkflowEditorActionInput) {
  return {
    canSave: input.dirty && input.structurallyValid,
    // Deploy performs an immediate authoritative validation. Cached background
    // validation may be stale and must never decide whether the action is
    // available.
    canDeploy:
      input.structurallyValid &&
      (input.dirty || (input.hasDraft && input.draftDeployedAs === null)),
  };
}

/**
 * Why Deploy is disabled, for the button's own tooltip. A disabled button that
 * does not say why reads as broken. Mirrors `workflowEditorActions`: null
 * exactly when `canDeploy` would be true for the same graph.
 */
export function deployUnavailableReason(input: {
  hasTrigger: boolean;
  saveIssueCount: number;
  dirty: boolean;
  hasDraft: boolean;
  draftDeployedAs: number | null;
}): string | null {
  if (!input.hasTrigger) return "Add a trigger block before deploying.";
  if (input.saveIssueCount === 1) {
    return "Fix the block marked with an error before deploying.";
  }
  if (input.saveIssueCount > 1) {
    return `Fix the ${input.saveIssueCount} blocks marked with an error before deploying.`;
  }
  if (!input.dirty && !input.hasDraft) {
    return "Nothing to deploy: the canvas holds no change and no saved draft.";
  }
  if (!input.dirty && input.draftDeployedAs !== null) {
    return `Nothing to deploy: the saved draft is already deployed as v${input.draftDeployedAs}.`;
  }
  return null;
}

/**
 * The deployed version a saved draft is identical to, for
 * `workflowEditorActions`. Compared by the same semantic keys as
 * `draftDiffersFromDeployed`, so the badge saying they differ and a Deploy
 * that stays off never disagree.
 */
export function draftDeployedAs(
  draftSemanticKey: string | null,
  deployedSemanticKey: string | null,
  deployedVersion: number | null,
): number | null {
  return draftSemanticKey !== null &&
    deployedSemanticKey !== null &&
    deployedVersion !== null &&
    draftSemanticKey === deployedSemanticKey
    ? deployedVersion
    : null;
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
