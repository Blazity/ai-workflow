/* oxlint-disable eslint/max-lines-per-function */
import { sql } from "drizzle-orm";
import type { Db } from "../../client.js";
import type { WorkflowBlockType } from "@shared/contracts";

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

function triggerArray(values: WorkflowBlockType[]) {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
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
     * same statement. A repeated revocation returns false and still settles any
     * pending occurrence left by an interrupted earlier call.
     */
    async revokeScheduleAndCancelWaiting(
      scheduleId: string,
      now: Date = new Date(),
      reason = "schedule_revoked",
      overwriteReason = false,
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
              skip_reason = case
                when ${overwriteReason} then ${reason}
                else coalesce(occurrence.skip_reason, ${reason})
              end,
              updated_at = now()
          FROM workflow_schedules schedule
          WHERE schedule.id = ${scheduleId}
            AND (schedule.revoked_at IS NOT NULL OR EXISTS (SELECT 1 FROM revoked))
            AND occurrence.schedule_id = schedule.id
            AND occurrence.pending = true
          RETURNING occurrence.schedule_id
        )
        SELECT EXISTS (SELECT 1 FROM revoked) AS revoked
      `);
      return { revoked: rows<{ revoked: boolean }>(result)[0]?.revoked ?? false };
    },

    async selectDeployment(input: {
      definitionId: number;
      expectedDraftRevision: number;
      expectedDeployedVersion: number | null;
      triggerTypes: WorkflowBlockType[];
      bindingTriggerTypes: WorkflowBlockType[];
    }): Promise<{ id: number; version: number } | null> {
      const result = await db.execute(sql`
        WITH candidate AS (
          SELECT wd.id, wd.enabled
          FROM workflow_definitions wd
          WHERE wd.id = ${input.definitionId}
            AND wd.archived_at IS NULL
            AND wd.deployed_version IS NOT DISTINCT FROM ${input.expectedDeployedVersion}
            AND COALESCE((SELECT MAX(v.version) FROM workflow_definition_versions v WHERE v.definition_id = wd.id), 0) = ${input.expectedDraftRevision}
          FOR UPDATE
        ), deleted_claims AS (
          DELETE FROM workflow_definition_triggers
          WHERE definition_id IN (SELECT id FROM candidate)
          RETURNING trigger_type
        ), inserted_claims AS (
          INSERT INTO workflow_definition_triggers (trigger_type, definition_id)
          SELECT trigger_type, candidate.id
          FROM candidate
          CROSS JOIN LATERAL unnest(${triggerArray(input.bindingTriggerTypes)}) AS trigger_type
          CROSS JOIN (SELECT count(*) FROM deleted_claims) AS delete_barrier
          WHERE candidate.enabled
          RETURNING trigger_type
        ), updated AS (
          UPDATE workflow_definitions definition
          SET deployed_version = ${input.expectedDraftRevision},
              trigger_types = ${triggerArray(input.triggerTypes)},
              updated_at = now()
          FROM candidate
          CROSS JOIN (SELECT count(*) FROM inserted_claims) AS claim_barrier
          WHERE definition.id = candidate.id
          RETURNING definition.id, definition.deployed_version AS version
        )
        SELECT id, version FROM updated
      `);
      return rows<{ id: number; version: number }>(result)[0] ?? null;
    },

    async selectRollback(input: {
      definitionId: number;
      version: number;
      expectedDeployedVersion: number | null;
      triggerTypes: WorkflowBlockType[];
      bindingTriggerTypes: WorkflowBlockType[];
    }): Promise<{ id: number; version: number } | null> {
      const result = await db.execute(sql`
        WITH candidate AS (
          SELECT id, enabled
          FROM workflow_definitions
          WHERE id = ${input.definitionId}
            AND archived_at IS NULL
            AND deployed_version IS NOT DISTINCT FROM ${input.expectedDeployedVersion}
          FOR UPDATE
        ), target AS (
          SELECT candidate.id, candidate.enabled, version.version
          FROM candidate
          JOIN workflow_definition_versions version
            ON version.definition_id = candidate.id AND version.version = ${input.version}
        ), deleted_claims AS (
          DELETE FROM workflow_definition_triggers
          WHERE definition_id IN (SELECT id FROM target)
          RETURNING trigger_type
        ), inserted_claims AS (
          INSERT INTO workflow_definition_triggers (trigger_type, definition_id)
          SELECT trigger_type, target.id
          FROM target
          CROSS JOIN LATERAL unnest(${triggerArray(input.bindingTriggerTypes)}) AS trigger_type
          CROSS JOIN (SELECT count(*) FROM deleted_claims) AS delete_barrier
          WHERE target.enabled
          RETURNING trigger_type
        ), updated AS (
          UPDATE workflow_definitions definition
          SET deployed_version = target.version,
              trigger_types = ${triggerArray(input.triggerTypes)},
              updated_at = now()
          FROM target
          CROSS JOIN (SELECT count(*) FROM inserted_claims) AS claim_barrier
          WHERE definition.id = target.id
          RETURNING definition.id, target.version
        )
        SELECT id, version FROM updated
      `);
      return rows<{ id: number; version: number }>(result)[0] ?? null;
    },

    async updateLifecycle(input: {
      definitionId: number;
      expectedDeployedVersion: number | null;
      expectedTriggerTypes: WorkflowBlockType[];
      enabled: boolean;
      name: string | undefined;
      bindingTriggerTypes: WorkflowBlockType[];
    }): Promise<number | null> {
      const result = await db.execute(sql`
        WITH candidate AS (
          SELECT id
          FROM workflow_definitions
          WHERE id = ${input.definitionId}
            AND archived_at IS NULL
            AND deployed_version IS NOT DISTINCT FROM ${input.expectedDeployedVersion}
            AND trigger_types = ${triggerArray(input.expectedTriggerTypes)}
          FOR UPDATE
        ), deleted_claims AS (
          DELETE FROM workflow_definition_triggers
          WHERE definition_id IN (SELECT id FROM candidate)
          RETURNING trigger_type
        ), inserted_claims AS (
          INSERT INTO workflow_definition_triggers (trigger_type, definition_id)
          SELECT trigger_type, candidate.id
          FROM candidate
          CROSS JOIN LATERAL unnest(${triggerArray(input.bindingTriggerTypes)}) AS trigger_type
          CROSS JOIN (SELECT count(*) FROM deleted_claims) AS delete_barrier
          WHERE ${input.enabled}
          RETURNING trigger_type
        ), updated AS (
          UPDATE workflow_definitions definition
          SET enabled = ${input.enabled},
              name = ${input.name === undefined ? sql`definition.name` : sql`${input.name}`},
              updated_at = now()
          FROM candidate
          CROSS JOIN (SELECT count(*) FROM inserted_claims) AS claim_barrier
          WHERE definition.id = candidate.id
          RETURNING definition.id
        )
        SELECT id FROM updated
      `);
      return rows<{ id: number }>(result)[0]?.id ?? null;
    },

    async updateName(input: { definitionId: number; name: string }): Promise<number | null> {
      const result = await db.execute(sql`
        UPDATE workflow_definitions
        SET name = ${input.name}, updated_at = now()
        WHERE id = ${input.definitionId} AND archived_at IS NULL
        RETURNING id
      `);
      return rows<{ id: number }>(result)[0]?.id ?? null;
    },
  };
}
