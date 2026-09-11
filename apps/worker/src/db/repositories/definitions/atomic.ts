/* oxlint-disable eslint/max-lines-per-function */
import { sql } from "drizzle-orm";
import type { Db } from "../../client.js";

export interface CreateDefinitionInput {
  name: string;
  layout: unknown;
  layoutRevision: number;
  actorId: string;
  actorLabel: string;
  initialDefinition: unknown | null;
}

export interface CreatedDefinition {
  definitionId: number;
  initialVersion: number | null;
}

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/**
 * Persistence operations for workflow definitions. This module deliberately
 * returns database-neutral identifiers only: definition parsing, roles, logging,
 * webhook minting, and schedule orchestration belong to the service tier.
 */
export function createDefinitionsRepository(db: Db) {
  return {
    /** Inserts a definition and its optional first immutable version as one SQL statement. */
    async createWithInitialVersion(input: CreateDefinitionInput): Promise<CreatedDefinition> {
      const initialDefinition = JSON.stringify(input.initialDefinition);
      const result = await db.execute(sql`
        WITH created AS (
          INSERT INTO workflow_definitions
            (name, enabled, trigger_types, layout, layout_revision, created_by_id, created_by_label)
          VALUES (
            ${input.name},
            false,
            ARRAY[]::text[],
            ${JSON.stringify(input.layout)}::jsonb,
            ${input.layoutRevision},
            ${input.actorId},
            ${input.actorLabel}
          )
          RETURNING id
        ), initial_version AS (
          INSERT INTO workflow_definition_versions
            (definition_id, version, definition, created_by_id, created_by_label, restored_from_version)
          SELECT
            created.id,
            1,
            ${initialDefinition}::jsonb,
            ${input.actorId},
            ${input.actorLabel},
            NULL
          FROM created
          WHERE ${input.initialDefinition !== null}
          RETURNING definition_id, version
        )
        SELECT created.id AS definition_id, initial_version.version AS initial_version
        FROM created
        LEFT JOIN initial_version ON initial_version.definition_id = created.id
      `);
      const created = rows<{ definition_id: number; initial_version: number | null }>(result)[0];
      if (!created) throw new Error("workflow definition insert did not return a row");
      return { definitionId: created.definition_id, initialVersion: created.initial_version };
    },

    /**
     * Revokes only a live schedule and settles its waiting occurrences in the
     * same statement. A repeated revocation is intentionally a no-op.
     */
    async revokeScheduleAndCancelWaiting(
      scheduleId: string,
      now: Date = new Date(),
    ): Promise<{ revoked: boolean }> {
      const result = await db.execute(sql`
        WITH revoked AS (
          UPDATE workflow_schedules
          SET revoked_at = ${now}, updated_at = now()
          WHERE id = ${scheduleId}
            AND revoked_at IS NULL
          RETURNING id
        ), cancelled AS (
          UPDATE schedule_occurrences AS occurrence
          SET outcome = 'cancelled',
              pending = false,
              skip_reason = coalesce(occurrence.skip_reason, 'schedule_revoked'),
              updated_at = now()
          FROM revoked
          WHERE occurrence.schedule_id = revoked.id
            AND occurrence.pending = true
          RETURNING occurrence.schedule_id
        )
        SELECT EXISTS (SELECT 1 FROM revoked) AS revoked
      `);
      return { revoked: rows<{ revoked: boolean }>(result)[0]?.revoked ?? false };
    },
  };
}
