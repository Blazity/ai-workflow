import { sql } from "drizzle-orm";
import type { WorkflowDefinitionLayoutInput } from "@shared/contracts";
import type { Db } from "../../types.js";
import { workflowDefinitions, workflowDefinitionVersions } from "../../schema.js";

function textArraySql(values: string[]) {
  return values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

export async function seedWorkflowDefinitionTemplate(
  db: Db,
  input: {
    name: string;
    marker: string;
    layout: WorkflowDefinitionLayoutInput;
    definition: unknown;
    triggerTypes: string[];
  },
): Promise<number> {
  const result = await db.execute(sql`
    WITH existing AS (
      SELECT id
      FROM ${workflowDefinitions}
      WHERE created_by_label = ${input.marker}
         OR (name = ${input.name} AND archived_at IS NULL)
      LIMIT 1
    ), inserted_definition AS (
      INSERT INTO ${workflowDefinitions} (
        name, enabled, trigger_types, layout, layout_revision, deployed_version,
        created_by_id, created_by_label
      )
      SELECT
        ${input.name}, false, ${textArraySql(input.triggerTypes)}, ${JSON.stringify(input.layout)}::jsonb,
        1, 1, 'system', ${input.marker}
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      ON CONFLICT (name) WHERE archived_at IS NULL
      DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    ), inserted_version AS (
      INSERT INTO ${workflowDefinitionVersions} (
        definition_id, version, definition, created_by_id, created_by_label, restored_from_version
      )
      SELECT
        inserted_definition.id, 1, ${JSON.stringify(input.definition)}::jsonb,
        'system', ${input.marker}, NULL
      FROM inserted_definition
      ON CONFLICT (definition_id, version) DO NOTHING
      RETURNING definition_id
    )
    SELECT id FROM existing
    UNION ALL
    SELECT id FROM inserted_definition
    LIMIT 1
  `);
  const row = (result as { rows?: Array<{ id: number }> }).rows?.[0];
  if (!row) throw new Error("workflow definition template seed did not return an id");
  return row.id;
}
