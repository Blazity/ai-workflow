import type { WorkflowBlockType } from "@shared/contracts";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../client.js";
import {
  workflowDefinitions,
  workflowDefinitionTriggers,
  workflowDefinitionVersions,
} from "../../schema.js";

export interface TriggerBindingCandidateRow {
  id: number;
  deployedVersion: number | null;
  triggerTypes: WorkflowBlockType[];
  deployedDefinition: unknown | null;
}

export interface ObservedTriggerOwnerState {
  exists: boolean;
  enabled: boolean;
  archivedAt: Date | null;
  deployedVersion: number | null;
}

export async function readTriggerBinding(
  db: Db,
  triggerType: WorkflowBlockType,
): Promise<number | null> {
  const rows = await db
    .select({ definitionId: workflowDefinitionTriggers.definitionId })
    .from(workflowDefinitionTriggers)
    .where(eq(workflowDefinitionTriggers.triggerType, triggerType))
    .limit(1);
  return rows[0]?.definitionId ?? null;
}

export async function listEnabledTriggerBindingCandidates(
  db: Db,
): Promise<TriggerBindingCandidateRow[]> {
  const rows = await db
    .select({
      id: workflowDefinitions.id,
      deployedVersion: workflowDefinitions.deployedVersion,
      triggerTypes: workflowDefinitions.triggerTypes,
      deployedDefinition: workflowDefinitionVersions.definition,
    })
    .from(workflowDefinitions)
    .leftJoin(
      workflowDefinitionVersions,
      and(
        eq(workflowDefinitionVersions.definitionId, workflowDefinitions.id),
        eq(workflowDefinitionVersions.version, workflowDefinitions.deployedVersion),
      ),
    )
    .where(and(eq(workflowDefinitions.enabled, true), isNull(workflowDefinitions.archivedAt)))
    .orderBy(asc(workflowDefinitions.id));
  return rows.map((row) =>
    Object.assign({}, row, { triggerTypes: row.triggerTypes as WorkflowBlockType[] }),
  );
}

export async function claimTriggerBindingIfMissing(
  db: Db,
  triggerType: WorkflowBlockType,
  definitionId: number,
): Promise<void> {
  await db
    .insert(workflowDefinitionTriggers)
    .values({ triggerType, definitionId })
    .onConflictDoNothing();
}

export async function deleteObservedTriggerBinding(
  db: Db,
  input: {
    triggerType: WorkflowBlockType;
    definitionId: number;
    observed: ObservedTriggerOwnerState;
  },
): Promise<void> {
  await db.execute(sql`
    DELETE FROM workflow_definition_triggers binding
    WHERE binding.trigger_type = ${input.triggerType}
      AND binding.definition_id = ${input.definitionId}
      AND ${input.observed.exists
        ? sql`EXISTS (
            SELECT 1
            FROM workflow_definitions definition
            WHERE definition.id = ${input.definitionId}
              AND definition.enabled = ${input.observed.enabled}
              AND definition.archived_at IS NOT DISTINCT FROM ${input.observed.archivedAt}
              AND definition.deployed_version IS NOT DISTINCT FROM ${input.observed.deployedVersion}
          )`
        : sql`NOT EXISTS (
            SELECT 1
            FROM workflow_definitions definition
            WHERE definition.id = ${input.definitionId}
          )`}
  `);
}
