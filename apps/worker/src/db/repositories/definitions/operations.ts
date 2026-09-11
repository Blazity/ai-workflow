import type {
  StoredWorkflowDefinition,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionLayout,
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionVersion,
} from "@shared/contracts";
import {
  normalizeWorkflowDefinitionLayout,
  RETIRED_SCHEMA_MESSAGE,
  workflowDefinitionSchemaVersionOf,
} from "@shared/contracts";
import { and, arrayContains, asc, desc, eq, isNull, max, or, sql } from "drizzle-orm";
import type { Db } from "../../client.js";
import { createDefinitionsRepository } from "./atomic.js";
import {
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../../schema.js";

const VERSION_LIST_LIMIT = 50;

export interface WorkflowDefinitionActor {
  /** Retained for request compatibility; authorization is enforced by services. */
  role: string;
  id: string;
  label: string;
}

export interface WorkflowDefinitionRow {
  id: number;
  name: string;
  enabled: boolean;
  deployedSchema: "v2" | "legacy-v1";
  retiredMessage?: typeof RETIRED_SCHEMA_MESSAGE;
  triggerTypes: WorkflowBlockType[];
  /** Latest saved semantic version; retained as the editor CAS name. */
  draftRevision: number;
  layout: WorkflowDefinitionLayout;
  layoutRevision: number;
  deployedVersion: number | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
  createdByLabel: string;
}

export interface WorkflowDefinitionListRow extends WorkflowDefinitionRow {
  currentVersion: number | null;
}

export interface WorkflowDefinitionDraftRow {
  definition: WorkflowDefinitionRow;
  draft: WorkflowDefinition;
  draftRevision: number;
}

export interface WorkflowDefinitionDraftStateRow {
  definition: WorkflowDefinitionRow;
  current: WorkflowDefinitionVersionRow;
}

interface WorkflowDefinitionVersionMetaRow {
  definitionId: number;
  version: number;
  createdAt: Date;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
}

/** A stored version as read back. Callers that need to run, deploy or copy the
 *  graph pass it through requireRunnableVersion first. */
export type WorkflowDefinitionVersionRow = WorkflowDefinitionVersionMetaRow &
  StoredWorkflowDefinition;

/** The graph of a version that can still run, and nothing at all for a retired
 *  one. Every reader that pulls a graph out of a version row wants exactly
 *  this, so the two arms are separated here instead of at each call site. */
export function runnableDefinitionOf(
  row: WorkflowDefinitionVersionRow | null | undefined,
): WorkflowDefinition | undefined {
  return row?.schema === "v2" ? row.definition : undefined;
}

/** Domain-level failure a write raises (409 conflict, 404 not found). Routes map
 *  statusCode onto the HTTP response; distinct from the 403 auth gate. */
export class WorkflowDefinitionStoreError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class WorkflowDefinitionValidationError extends WorkflowDefinitionStoreError {
  constructor(public readonly issues: WorkflowDefinitionValidationIssue[]) {
    super(422, "Workflow has validation errors");
  }
}

type DefinitionSelect = typeof workflowDefinitions.$inferSelect;
type VersionSelect = typeof workflowDefinitionVersions.$inferSelect;

function normalizeLayout(value: unknown): WorkflowDefinitionLayout {
  return normalizeWorkflowDefinitionLayout(value);
}

function mapDefinitionRow(
  row: DefinitionSelect,
  draftRevision = 0,
  deployed: WorkflowDefinitionVersionRow | null = null,
): WorkflowDefinitionRow {
  const deployedSchema = deployed?.schema === "legacy-v1" ? "legacy-v1" : "v2";
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    deployedSchema,
    ...(deployedSchema === "legacy-v1"
      ? { retiredMessage: RETIRED_SCHEMA_MESSAGE }
      : {}),
    triggerTypes: row.triggerTypes as WorkflowBlockType[],
    draftRevision,
    layout: normalizeLayout(row.layout),
    layoutRevision: row.layoutRevision,
    deployedVersion: row.deployedVersion,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
  };
}

function mapVersionRow(row: VersionSelect): WorkflowDefinitionVersionRow {
  return {
    definitionId: row.definitionId,
    version: row.version,
    createdAt: row.createdAt,
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
    ...(workflowDefinitionSchemaVersionOf(row.definition) === 1
      ? { schema: "legacy-v1" as const, definition: row.definition }
      : { schema: "v2" as const, definition: row.definition as WorkflowDefinition }),
  };
}

// --- Reads (no role gate) ---

export async function listWorkflowDefinitions(db: Db): Promise<WorkflowDefinitionListRow[]> {
  const defs = await db
    .select()
    .from(workflowDefinitions)
    .where(isNull(workflowDefinitions.archivedAt))
    .orderBy(asc(workflowDefinitions.id));
  if (defs.length === 0) return [];

  const heads = await db
    .select({
      definitionId: workflowDefinitionVersions.definitionId,
      currentVersion: max(workflowDefinitionVersions.version),
    })
    .from(workflowDefinitionVersions)
    .groupBy(workflowDefinitionVersions.definitionId);
  const headByDefinition = new Map(heads.map((head) => [head.definitionId, head.currentVersion]));
  const deployedDefinitions = defs.filter((row) => row.deployedVersion != null);
  const deployedRows =
    deployedDefinitions.length === 0
      ? []
      : await db
          .select()
          .from(workflowDefinitionVersions)
          .where(
            or(
              ...deployedDefinitions.map((row) =>
                and(
                  eq(workflowDefinitionVersions.definitionId, row.id),
                  eq(workflowDefinitionVersions.version, row.deployedVersion!),
                ),
              ),
            ),
          );
  const deployedByDefinition = new Map(
    deployedRows.map((row) => [row.definitionId, mapVersionRow(row)]),
  );
  return defs.map((row) => ({
    ...mapDefinitionRow(
      row,
      headByDefinition.get(row.id) ?? 0,
      deployedByDefinition.get(row.id) ?? null,
    ),
    currentVersion: headByDefinition.get(row.id) ?? null,
  }));
}

export async function getWorkflowDefinition(
  db: Db,
  id: number,
): Promise<WorkflowDefinitionRow | null> {
  const rows = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, id))
    .limit(1);
  if (!rows[0]) return null;
  const [current, deployed] = await Promise.all([
    getCurrentWorkflowDefinitionVersion(db, id),
    rows[0].deployedVersion === null
      ? Promise.resolve(null)
      : getWorkflowDefinitionVersion(db, id, rows[0].deployedVersion),
  ]);
  return mapDefinitionRow(rows[0], current?.version ?? 0, deployed);
}

export async function getWorkflowDefinitionName(
  db: Db,
  id: number,
): Promise<{ name: string } | null> {
  const rows = await db
    .select({ name: workflowDefinitions.name })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Loads definition lifecycle metadata and its head revision without decoding
 * the head JSON. Normal editor/runtime reads continue through
 * getWorkflowDefinition; raw migration preflight uses this seam so malformed
 * or retired history can be reported as blockers instead of normalized first. */
export async function getWorkflowDefinitionRawState(
  db: Db,
  id: number,
): Promise<WorkflowDefinitionRow | null> {
  const rows = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const [{ currentVersion }] = await db
    .select({ currentVersion: max(workflowDefinitionVersions.version) })
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.definitionId, id));
  const deployed =
    row.deployedVersion === null
      ? null
      : await getWorkflowDefinitionVersion(db, id, row.deployedVersion);
  return mapDefinitionRow(row, currentVersion ?? 0, deployed);
}

export async function getWorkflowDefinitionDraftState(
  db: Db,
  definitionId: number,
): Promise<WorkflowDefinitionDraftStateRow | null> {
  const [definition, current] = await Promise.all([
    getWorkflowDefinition(db, definitionId),
    getCurrentWorkflowDefinitionVersion(db, definitionId),
  ]);
  if (!definition || !current) return null;
  return { definition, current };
}

export async function getCurrentWorkflowDefinitionVersion(
  db: Db,
  definitionId: number,
): Promise<WorkflowDefinitionVersionRow | null> {
  const rows = await db
    .select()
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.definitionId, definitionId))
    .orderBy(desc(workflowDefinitionVersions.version))
    .limit(1);
  return rows[0] ? mapVersionRow(rows[0]) : null;
}

export async function getWorkflowDefinitionVersion(
  db: Db,
  definitionId: number,
  version: number,
): Promise<WorkflowDefinitionVersionRow | null> {
  const rows = await db
    .select()
    .from(workflowDefinitionVersions)
    .where(
      and(
        eq(workflowDefinitionVersions.definitionId, definitionId),
        eq(workflowDefinitionVersions.version, version),
      ),
    )
    .limit(1);
  return rows[0] ? mapVersionRow(rows[0]) : null;
}

export async function getDeployedWorkflowDefinitionVersion(
  db: Db,
  definitionId: number,
): Promise<WorkflowDefinitionVersionRow | null> {
  const rows = await db
    .select({ version: workflowDefinitions.deployedVersion })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, definitionId))
    .limit(1);
  const version = rows[0]?.version;
  return version == null ? null : getWorkflowDefinitionVersion(db, definitionId, version);
}

export async function listWorkflowDefinitionVersionRows(
  db: Db,
  definitionId: number,
): Promise<WorkflowDefinitionVersionRow[]> {
  const rows = await db
    .select()
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.definitionId, definitionId))
    .orderBy(desc(workflowDefinitionVersions.version))
    .limit(VERSION_LIST_LIMIT);
  return rows.map(mapVersionRow);
}

/** Loads a definition by id, but only when it is a live handler: enabled, not
 *  archived, and pointing at a readable deployed version. Returns the DEPLOYED
 *  snapshot (never the draft head) in the same { definition, current } shape as
 *  trigger routing, so per-endpoint routing (which resolves
 *  the owning definition directly from its endpoint id, not from a singleton
 *  trigger binding) receives an identical result. Any unmet condition yields null. */
// --- Writes ---
//
// These functions accept DB-shaped inputs and return only rows or CAS signals.
// Validation, canonicalization, retry policy, and HTTP-facing errors belong to
// services/workflow-definitions.

export async function insertWorkflowDefinition(
  db: Db,
  input: {
    name: string;
    layout: WorkflowDefinitionLayout;
    layoutRevision: number;
    actorId: string;
    actorLabel: string;
    initialDefinition: WorkflowDefinition | null;
  },
): Promise<{ definitionId: number; initialVersion: number | null }> {
  return createDefinitionsRepository(db).createWithInitialVersion(input);
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export async function appendWorkflowDefinitionDraft(
  db: Db,
  input: {
    definitionId: number;
    definition: WorkflowDefinition;
    expectedDraftRevision: number;
    actorId: string;
    actorLabel: string;
  },
): Promise<{ id: number; version: number } | null> {
  try {
    const result = await db.execute(sql`
      WITH candidate AS (
        SELECT wd.id
        FROM workflow_definitions wd
        WHERE wd.id = ${input.definitionId}
          AND wd.archived_at IS NULL
          AND COALESCE((
            SELECT MAX(v.version)
            FROM workflow_definition_versions v
            WHERE v.definition_id = wd.id
          ), 0) = ${input.expectedDraftRevision}
        FOR UPDATE
      ), inserted AS (
        INSERT INTO workflow_definition_versions
          (definition_id, version, definition, created_by_id, created_by_label, restored_from_version)
        SELECT c.id, ${input.expectedDraftRevision + 1}, ${JSON.stringify(input.definition)}::jsonb,
          ${input.actorId}, ${input.actorLabel}, NULL
        FROM candidate c
        RETURNING definition_id AS id, version
      ), updated AS (
        UPDATE workflow_definitions wd
        SET updated_at = now()
        FROM inserted i
        WHERE wd.id = i.id
        RETURNING wd.id
      )
      SELECT i.id, i.version
      FROM inserted i
      JOIN updated u ON u.id = i.id
    `);
    return rawRows<{ id: number; version: number }>(result)[0] ?? null;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; current && depth < 5; depth++) {
      if ((current as { code?: string }).code === "23505") return null;
      const message = current instanceof Error ? current.message : String(current);
      if (/duplicate key value|unique constraint/i.test(message)) return null;
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
}

export async function updateWorkflowDefinitionLayout(
  db: Db,
  input: {
    definitionId: number;
    layout: WorkflowDefinitionLayout;
    expectedLayoutRevision: number;
  },
): Promise<number | null> {
  const rows = await db
    .update(workflowDefinitions)
    .set({
      layout: input.layout,
      layoutRevision: sql`${workflowDefinitions.layoutRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowDefinitions.id, input.definitionId),
        eq(workflowDefinitions.layoutRevision, input.expectedLayoutRevision),
        isNull(workflowDefinitions.archivedAt),
      ),
    )
    .returning();
  return rows[0]?.id ?? null;
}

export async function appendWorkflowDefinitionVersion(
  db: Db,
  input: {
    definitionId: number;
    definition: WorkflowDefinition;
    restoredFromVersion?: number;
    actorId: string;
    actorLabel: string;
  },
): Promise<{ id: number; version: number } | null> {
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT id
      FROM workflow_definitions
      WHERE id = ${input.definitionId}
        AND archived_at IS NULL
      FOR UPDATE
    ), next_version AS (
      SELECT candidate.id, COALESCE(MAX(version.version), 0) + 1 AS version
      FROM candidate
      LEFT JOIN workflow_definition_versions version ON version.definition_id = candidate.id
      GROUP BY candidate.id
    ), inserted AS (
      INSERT INTO workflow_definition_versions
        (definition_id, version, definition, created_by_id, created_by_label, restored_from_version)
      SELECT next_version.id, next_version.version, ${JSON.stringify(input.definition)}::jsonb,
        ${input.actorId}, ${input.actorLabel}, ${input.restoredFromVersion ?? null}
      FROM next_version
      RETURNING definition_id AS id, version
    ), updated AS (
      UPDATE workflow_definitions definition
      SET updated_at = now()
      FROM inserted
      WHERE definition.id = inserted.id
      RETURNING definition.id
    )
    SELECT inserted.id, inserted.version
    FROM inserted
    JOIN updated ON updated.id = inserted.id
  `);
  return rawRows<{ id: number; version: number }>(result)[0] ?? null;
}

export async function archiveWorkflowDefinition(
  db: Db,
  input: { definitionId: number },
): Promise<number | null> {
  const result = await db.execute(sql`
    WITH active AS MATERIALIZED (
      SELECT id
      FROM workflow_definitions
      WHERE archived_at IS NULL
      ORDER BY id
      FOR UPDATE
    ), archived AS (
      UPDATE workflow_definitions wd
      SET archived_at = now(),
          updated_at = now()
      WHERE wd.id = ${input.definitionId}
        AND wd.archived_at IS NULL
        AND wd.enabled = false
        AND (SELECT count(*) FROM active) > 1
      RETURNING wd.id
    ), deleted_claims AS (
      DELETE FROM workflow_definition_triggers
      WHERE definition_id IN (SELECT id FROM archived)
      RETURNING definition_id
    )
    SELECT archived.id
    FROM archived
    CROSS JOIN (SELECT count(*) FROM deleted_claims) AS claim_barrier
  `);

  return rawRows<{ id: number }>(result)[0]?.id ?? null;
}

// --- Serialization ---

export function serializeWorkflowDefinitionVersion(
  row: WorkflowDefinitionVersionRow,
): WorkflowDefinitionVersion {
  const meta = {
    version: row.version,
    definitionId: row.definitionId,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
  return row.schema === "v2"
    ? { ...meta, schema: "v2", definition: row.definition }
    : { ...meta, schema: "legacy-v1", definition: row.definition };
}

// --- Back-compat wrappers (temporary; removed by stage B3) ---
//
// The pre-named-definition store had one global version log. These keep the old
// call sites (routes, definition-step.ts, their tests) working byte-for-byte by
// targeting the seeded default definition. Store errors already expose the
// statusCode consumed by the existing transport mapper.

async function resolveDefaultDefinitionId(db: Db): Promise<number> {
  const enabled = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(
      and(
        eq(workflowDefinitions.enabled, true),
        isNull(workflowDefinitions.archivedAt),
        arrayContains(workflowDefinitions.triggerTypes, ["trigger_ticket_ai"]),
      ),
    )
    .orderBy(asc(workflowDefinitions.id))
    .limit(1);
  if (enabled[0]) return enabled[0].id;

  const lowest = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .orderBy(asc(workflowDefinitions.id))
    .limit(1);
  if (!lowest[0]) {
    throw new WorkflowDefinitionStoreError(500, "No workflow definition");
  }
  return lowest[0].id;
}

export async function listWorkflowDefinitionVersions(
  db: Db,
): Promise<WorkflowDefinitionVersionRow[]> {
  const definitionId = await resolveDefaultDefinitionId(db);
  return listWorkflowDefinitionVersionRows(db, definitionId);
}
