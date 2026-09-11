import type { WorkflowDefinition } from "@shared/contracts";
import type { Db } from "../db/types.js";
import {
  getWorkflowDefinitionDraftState,
  type WorkflowDefinitionDraftRow,
  type WorkflowDefinitionDraftStateRow,
} from "../db/repositories/definitions.js";
import { getConnectedWorkflowDefinitionDraftState } from "../db/repositories/definitions/connected.js";
import { parseOptionalWorkflowDefinitionVersionRow } from "./stored-definition-reads.js";

function applyLayout(
  definition: WorkflowDefinition,
  layout: WorkflowDefinitionDraftStateRow["definition"]["layout"],
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      const position = layout.nodes[node.id];
      return position ? { ...node, ...position } : node;
    }),
  };
}

function materializeWorkflowDefinitionDraft(
  state: WorkflowDefinitionDraftStateRow | null,
): WorkflowDefinitionDraftRow | null {
  if (!state) return null;
  const current = parseOptionalWorkflowDefinitionVersionRow(state.current);
  if (!current || current.schema !== "v2") return null;
  return {
    definition: state.definition,
    draft: applyLayout(current.definition, state.definition.layout),
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
