import type { StoredWorkflowDefinition } from "@shared/contracts";
import type { WorkflowDefinitionVersionRow } from "../db/repositories/definitions.js";
import type { Db } from "../db/types.js";
import {
  getCurrentWorkflowDefinitionVersion as getCurrentVersionRow,
  getDeployedWorkflowDefinitionVersion as getDeployedVersionRow,
  getWorkflowDefinitionVersion as getVersionRow,
} from "../db/repositories/definitions.js";
import {
  getConnectedCurrentWorkflowDefinitionVersion as getConnectedCurrentVersionRow,
  getConnectedDeployedWorkflowDefinitionVersion as getConnectedDeployedVersionRow,
  getConnectedWorkflowDefinitionVersion as getConnectedVersionRow,
  listConnectedWorkflowDefinitionVersionRows as listConnectedVersionRows,
} from "../db/repositories/definitions/connected.js";
import { parseStoredWorkflowDefinition } from "../workflow-definition/stored-definition.js";

type VersionMetadata = Omit<WorkflowDefinitionVersionRow, keyof StoredWorkflowDefinition>;

function parseWorkflowDefinitionVersionRow(
  row: WorkflowDefinitionVersionRow,
): WorkflowDefinitionVersionRow {
  const metadata: VersionMetadata = {
    definitionId: row.definitionId,
    version: row.version,
    createdAt: row.createdAt,
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
  return { ...metadata, ...parseStoredWorkflowDefinition(row.definition) };
}

export function parseOptionalWorkflowDefinitionVersionRow(
  row: WorkflowDefinitionVersionRow | null,
): WorkflowDefinitionVersionRow | null {
  return row ? parseWorkflowDefinitionVersionRow(row) : null;
}

function parseWorkflowDefinitionVersionRows(
  rows: WorkflowDefinitionVersionRow[],
): WorkflowDefinitionVersionRow[] {
  return rows.map(parseWorkflowDefinitionVersionRow);
}

export async function readWorkflowDefinitionVersion(db: Db, definitionId: number, version: number) {
  return parseOptionalWorkflowDefinitionVersionRow(await getVersionRow(db, definitionId, version));
}

export async function readCurrentWorkflowDefinitionVersion(db: Db, definitionId: number) {
  return parseOptionalWorkflowDefinitionVersionRow(await getCurrentVersionRow(db, definitionId));
}

export async function readDeployedWorkflowDefinitionVersion(db: Db, definitionId: number) {
  return parseOptionalWorkflowDefinitionVersionRow(await getDeployedVersionRow(db, definitionId));
}

export async function readConnectedWorkflowDefinitionVersion(definitionId: number, version: number) {
  return parseOptionalWorkflowDefinitionVersionRow(await getConnectedVersionRow(definitionId, version));
}

export async function readConnectedCurrentWorkflowDefinitionVersion(definitionId: number) {
  return parseOptionalWorkflowDefinitionVersionRow(await getConnectedCurrentVersionRow(definitionId));
}

export async function readConnectedDeployedWorkflowDefinitionVersion(definitionId: number) {
  return parseOptionalWorkflowDefinitionVersionRow(await getConnectedDeployedVersionRow(definitionId));
}

export async function readConnectedWorkflowDefinitionVersionRows(definitionId: number) {
  return parseWorkflowDefinitionVersionRows(await listConnectedVersionRows(definitionId));
}
