import type { Db } from "../db/types.js";
import {
  getWorkflowDefinitionDraftState,
  type WorkflowDefinitionDraftRow,
  type WorkflowDefinitionDraftStateRow,
} from "../db/repositories/definitions.js";
import { getConnectedWorkflowDefinitionDraftState } from "../db/repositories/definitions/connected.js";
import { applyWorkflowDefinitionLayout } from "../workflow-definition/layout.js";
import { parseOptionalWorkflowDefinitionVersionRow } from "./stored-definition-reads.js";

function materializeWorkflowDefinitionDraft(
  state: WorkflowDefinitionDraftStateRow | null,
): WorkflowDefinitionDraftRow | null {
  if (!state) return null;
  const current = parseOptionalWorkflowDefinitionVersionRow(state.current);
  if (!current || current.schema !== "v2") return null;
  return {
    definition: state.definition,
    draft: applyWorkflowDefinitionLayout(current.definition, state.definition.layout),
    draftRevision: current.version,
  };
}

export async function readWorkflowDefinitionDraft(
  db: Db,
  definitionId: number,
): Promise<WorkflowDefinitionDraftRow | null> {
  return materializeWorkflowDefinitionDraft(
    await getWorkflowDefinitionDraftState(db, definitionId),
  );
}

export async function readConnectedWorkflowDefinitionDraft(
  definitionId: number,
): Promise<WorkflowDefinitionDraftRow | null> {
  return materializeWorkflowDefinitionDraft(
    await getConnectedWorkflowDefinitionDraftState(definitionId),
  );
}
