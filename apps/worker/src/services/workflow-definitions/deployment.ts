/**
 * Which version of a definition is the live one.
 *
 * Two operations, both compare-and-set against the version the caller believed
 * was deployed: publishing the draft, and selecting an older version again.
 * Restoring and rolling back are the same operation under two names, since
 * "make version N live" does not care whether N is behind or ahead of what an
 * operator last published.
 */
import { canEditWorkflowDefinitions } from "@shared/contracts";
import {
  type WorkflowDefinitionRow,
  type WorkflowDefinitionVersionRow,
} from "../../db/repositories/definitions.js";
import {
  resolveWorkflowDefinitionActor,
  type WorkflowDefinitionRequestActor,
} from "./definition-authoring.js";
import {
  deployConnectedWorkflowDefinition,
  rollbackConnectedWorkflowDefinition,
  WorkflowDefinitionStoreError,
} from "./policy-operations.js";

function requireWorkflowDefinitionEditor(role: WorkflowDefinitionRequestActor["role"]): void {
  if (!canEditWorkflowDefinitions(role)) {
    throw new WorkflowDefinitionStoreError(403, "Forbidden");
  }
}

export interface DeployedWorkflowDefinition {
  definition: WorkflowDefinitionRow;
  version: WorkflowDefinitionVersionRow;
}

/** Publish the current draft as a new version and make it live. */
export async function deployWorkflowDefinitionDraft(input: {
  definitionId: number;
  expectedDraftRevision: number;
  expectedDeployedVersion: number | null;
  actor: WorkflowDefinitionRequestActor;
}): Promise<DeployedWorkflowDefinition> {
  requireWorkflowDefinitionEditor(input.actor.role);
  return deployConnectedWorkflowDefinition({
    definitionId: input.definitionId,
    expectedDraftRevision: input.expectedDraftRevision,
    expectedDeployedVersion: input.expectedDeployedVersion,
    actor: await resolveWorkflowDefinitionActor(input.actor),
  });
}

/** Make an already stored version live again. */
export async function selectWorkflowDefinitionVersion(input: {
  definitionId: number;
  version: number;
  expectedDeployedVersion: number | null;
  actor: WorkflowDefinitionRequestActor;
}): Promise<DeployedWorkflowDefinition> {
  requireWorkflowDefinitionEditor(input.actor.role);
  return rollbackConnectedWorkflowDefinition({
    definitionId: input.definitionId,
    version: input.version,
    expectedDeployedVersion: input.expectedDeployedVersion,
    actor: await resolveWorkflowDefinitionActor(input.actor),
  });
}
