import type { WorkflowDefinition, WorkflowDefinitionVersion } from "@shared/contracts";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { workflowDefinitionVersions } from "../db/schema.js";
import { canEditWorkflowDefinitions, type DashboardRole } from "../lib/auth/roles.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";

const VERSION_LIST_LIMIT = 50;

export interface WorkflowDefinitionVersionRow {
  version: number;
  definition: WorkflowDefinition;
  createdAt: Date;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
}

export async function getCurrentWorkflowDefinition(
  db: Db,
): Promise<WorkflowDefinitionVersionRow | null> {
  const rows = await db
    .select()
    .from(workflowDefinitionVersions)
    .orderBy(desc(workflowDefinitionVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function listWorkflowDefinitionVersions(
  db: Db,
): Promise<WorkflowDefinitionVersionRow[]> {
  return db
    .select()
    .from(workflowDefinitionVersions)
    .orderBy(desc(workflowDefinitionVersions.version))
    .limit(VERSION_LIST_LIMIT);
}

export interface SaveWorkflowDefinitionInput {
  actorRole: DashboardRole;
  actorId: string;
  actorLabel: string;
  definition: WorkflowDefinition;
  restoredFromVersion?: number;
}

export async function saveWorkflowDefinition(
  db: Db,
  input: SaveWorkflowDefinitionInput,
): Promise<WorkflowDefinitionVersionRow> {
  if (!canEditWorkflowDefinitions(input.actorRole)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  const rows = await db
    .insert(workflowDefinitionVersions)
    .values({
      definition: input.definition,
      createdById: input.actorId,
      createdByLabel: input.actorLabel,
      restoredFromVersion: input.restoredFromVersion ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function restoreWorkflowDefinition(
  db: Db,
  input: { actorRole: DashboardRole; actorId: string; actorLabel: string; version: number },
): Promise<WorkflowDefinitionVersionRow> {
  if (!canEditWorkflowDefinitions(input.actorRole)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  const rows = await db
    .select()
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.version, input.version))
    .limit(1);
  const source = rows[0];
  if (!source) {
    throw new DashboardAuthError(404, "Unknown version");
  }
  return saveWorkflowDefinition(db, {
    actorRole: input.actorRole,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    definition: source.definition,
    restoredFromVersion: source.version,
  });
}

export function serializeWorkflowDefinitionVersion(
  row: WorkflowDefinitionVersionRow,
): WorkflowDefinitionVersion {
  return {
    version: row.version,
    definition: row.definition,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
}
