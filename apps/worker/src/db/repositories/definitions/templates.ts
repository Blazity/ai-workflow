import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { WorkflowDefinitionLayoutInput } from "@shared/contracts";
import type { Db } from "../../types.js";
import { workflowDefinitions, workflowDefinitionVersions } from "../../schema.js";

function textArraySql(values: string[]) {
  return values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

export async function findWorkflowDefinitionTemplate(
  db: Db,
  input: { marker: string; name: string },
): Promise<number | null> {
  const rows = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(
      or(
        eq(workflowDefinitions.createdByLabel, input.marker),
        and(eq(workflowDefinitions.name, input.name), isNull(workflowDefinitions.archivedAt)),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function createWorkflowDefinitionTemplate(
  db: Db,
  input: {
    name: string;
    marker: string;
    layout: WorkflowDefinitionLayoutInput;
  },
): Promise<number> {
  const rows = await db
    .insert(workflowDefinitions)
    .values({
      name: input.name,
      enabled: false,
      triggerTypes: [],
      layout: input.layout,
      layoutRevision: 1,
      createdById: "system",
      createdByLabel: input.marker,
    })
    .returning({ id: workflowDefinitions.id });
  return rows[0]!.id;
}

export async function writeWorkflowDefinitionTemplateVersion(
  db: Db,
  input: { definitionId: number; definition: unknown; marker: string; triggerTypes: string[] },
): Promise<void> {
  await db.execute(sql`
    WITH inserted_version AS (
      INSERT INTO ${workflowDefinitionVersions} (
        definition_id, version, definition, created_by_id, created_by_label, restored_from_version
      )
      VALUES (
        ${input.definitionId}, 1, ${JSON.stringify(input.definition)}::jsonb,
        'system', ${input.marker}, NULL
      )
      RETURNING definition_id
    )
    UPDATE ${workflowDefinitions}
    SET deployed_version = 1,
        trigger_types = ${textArraySql(input.triggerTypes)},
        updated_at = now()
    FROM inserted_version
    WHERE ${workflowDefinitions.id} = inserted_version.definition_id
  `);
}

export async function deleteWorkflowDefinitionTemplate(db: Db, definitionId: number): Promise<void> {
  await db.execute(sql`
    WITH deleted_versions AS (
      DELETE FROM ${workflowDefinitionVersions}
      WHERE ${workflowDefinitionVersions.definitionId} = ${definitionId}
      RETURNING definition_id
    )
    DELETE FROM ${workflowDefinitions}
    WHERE ${workflowDefinitions.id} = ${definitionId}
  `);
}
