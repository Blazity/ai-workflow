/**
 * Which version of a definition is the live one.
 *
 * Two operations, both compare-and-set against the version the caller believed
 * was deployed: publishing the draft, and selecting an older version again.
 * Restoring and rolling back are the same operation under two names, since
 * "make version N live" does not care whether N is behind or ahead of what an
 * operator last published.
 */
import { getDb } from "../../db/client.js";
import {
  deployWorkflowDefinition,
  rollbackWorkflowDefinition,
  type WorkflowDefinitionRow,
  type WorkflowDefinitionVersionRow,
} from "../../db/repositories/definitions.js";
import {
  resolveWorkflowDefinitionActor,
  type WorkflowDefinitionRequestActor,
} from "./definition-authoring.js";

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
  const db = getDb();
  return deployWorkflowDefinition(db, {
    definitionId: input.definitionId,
    expectedDraftRevision: input.expectedDraftRevision,
    expectedDeployedVersion: input.expectedDeployedVersion,
    actor: await resolveWorkflowDefinitionActor(db, input.actor),
  });
}

/** Make an already stored version live again. */
export async function selectWorkflowDefinitionVersion(input: {
  definitionId: number;
  version: number;
  expectedDeployedVersion: number | null;
  actor: WorkflowDefinitionRequestActor;
}): Promise<DeployedWorkflowDefinition> {
  const db = getDb();
  return rollbackWorkflowDefinition(db, {
    definitionId: input.definitionId,
    version: input.version,
    expectedDeployedVersion: input.expectedDeployedVersion,
    actor: await resolveWorkflowDefinitionActor(db, input.actor),
  });
}
