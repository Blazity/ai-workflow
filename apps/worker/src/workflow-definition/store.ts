import type { WorkflowBlockType, WorkflowDefinition, WorkflowDefinitionVersion } from "@shared/contracts";
import { isTriggerBlockType } from "@shared/contracts";
import { and, arrayContains, arrayOverlaps, asc, desc, eq, isNull, max, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { workflowDefinitions, workflowDefinitionVersions } from "../db/schema.js";
import { canEditWorkflowDefinitions, type DashboardRole } from "../lib/auth/roles.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";

const VERSION_LIST_LIMIT = 50;

export interface WorkflowDefinitionActor {
  role: DashboardRole;
  id: string;
  label: string;
}

export interface WorkflowDefinitionRow {
  id: number;
  name: string;
  enabled: boolean;
  triggerTypes: WorkflowBlockType[];
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
  createdByLabel: string;
}

export interface WorkflowDefinitionListRow extends WorkflowDefinitionRow {
  currentVersion: number | null;
}

export interface WorkflowDefinitionVersionRow {
  definitionId: number;
  version: number;
  definition: WorkflowDefinition;
  createdAt: Date;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
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

type DefinitionSelect = typeof workflowDefinitions.$inferSelect;
type VersionSelect = typeof workflowDefinitionVersions.$inferSelect;

function mapDefinitionRow(row: DefinitionSelect): WorkflowDefinitionRow {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    triggerTypes: row.triggerTypes as WorkflowBlockType[],
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
    definition: row.definition,
    createdAt: row.createdAt,
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
}

function triggerTypesOf(definition: WorkflowDefinition): WorkflowBlockType[] {
  const types = new Set<WorkflowBlockType>();
  for (const node of definition.nodes) {
    if (isTriggerBlockType(node.type)) types.add(node.type);
  }
  return [...types];
}

function requireEditRole(role: DashboardRole): void {
  if (!canEditWorkflowDefinitions(role)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
}

/** Walks the error cause chain (drizzle wraps the driver error) looking for a
 *  unique-violation signal, by SQLSTATE 23505 or message. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: string }).code;
    if (code === "23505") return true;
    const message = current instanceof Error ? current.message : String(current);
    if (/duplicate key value|unique constraint/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
  const headByDefinition = new Map(heads.map((h) => [h.definitionId, h.currentVersion]));

  return defs.map((row) => ({
    ...mapDefinitionRow(row),
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
  return rows[0] ? mapDefinitionRow(rows[0]) : null;
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

export async function getEnabledWorkflowDefinitionForTrigger(
  db: Db,
  triggerType: WorkflowBlockType,
): Promise<{ definition: WorkflowDefinitionRow; current: WorkflowDefinitionVersionRow | null } | null> {
  const rows = await db
    .select()
    .from(workflowDefinitions)
    .where(
      and(
        eq(workflowDefinitions.enabled, true),
        isNull(workflowDefinitions.archivedAt),
        arrayContains(workflowDefinitions.triggerTypes, [triggerType]),
      ),
    )
    .orderBy(asc(workflowDefinitions.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const current = await getCurrentWorkflowDefinitionVersion(db, row.id);
  return { definition: mapDefinitionRow(row), current };
}

// --- Writes (role-gated). neon-http (the production driver, also loaded inside
// Workflow DevKit step bundles) has no interactive transactions, so each write is
// a single statement or a retry-guarded sequence. The (definition_id, version) PK
// and the active-name unique index — not a lock — provide the real guarantees. ---

/** Retries an operation on a unique-violation. Used for the version-number insert,
 *  the one race left now that writes run per-statement instead of under a lock. */
async function retryOnUniqueViolation<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < attempts && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

/** 409 if another enabled, non-archived definition already handles any of
 *  `triggerTypes`. Empty `triggerTypes` can never overlap. */
async function assertNoTriggerOverlap(
  db: Db,
  input: { definitionId: number; triggerTypes: WorkflowBlockType[] },
): Promise<void> {
  if (input.triggerTypes.length === 0) return;
  const conflicts = await db
    .select({ name: workflowDefinitions.name })
    .from(workflowDefinitions)
    .where(
      and(
        eq(workflowDefinitions.enabled, true),
        isNull(workflowDefinitions.archivedAt),
        ne(workflowDefinitions.id, input.definitionId),
        arrayOverlaps(workflowDefinitions.triggerTypes, input.triggerTypes),
      ),
    )
    .limit(1);
  const conflict = conflicts[0];
  if (conflict) {
    throw new WorkflowDefinitionStoreError(
      409,
      `Its trigger is already handled by the enabled definition "${conflict.name}"`,
    );
  }
}

export async function createWorkflowDefinition(
  db: Db,
  input: { name: string; seed: WorkflowDefinition | null; actor: WorkflowDefinitionActor },
): Promise<{ definition: WorkflowDefinitionRow; current: WorkflowDefinitionVersionRow | null }> {
  requireEditRole(input.actor.role);
  let created: DefinitionSelect;
  try {
    const rows = await db
      .insert(workflowDefinitions)
      .values({
        name: input.name,
        enabled: false,
        triggerTypes: input.seed ? triggerTypesOf(input.seed) : [],
        createdById: input.actor.id,
        createdByLabel: input.actor.label,
      })
      .returning();
    created = rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkflowDefinitionStoreError(409, "Name already in use");
    }
    throw error;
  }

  let current: WorkflowDefinitionVersionRow | null = null;
  if (input.seed) {
    try {
      const versions = await db
        .insert(workflowDefinitionVersions)
        .values({
          definitionId: created.id,
          version: 1,
          definition: input.seed,
          createdById: input.actor.id,
          createdByLabel: input.actor.label,
          restoredFromVersion: null,
        })
        .returning();
      current = mapVersionRow(versions[0]!);
    } catch (error) {
      // No transaction on neon-http: if the seed version fails to insert, remove
      // the just-created definition so we never leave one without its version
      // (which would silently fall back to the built-in default graph).
      await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, created.id)).catch(() => {});
      throw error;
    }
  }
  return { definition: mapDefinitionRow(created), current };
}

export async function saveWorkflowDefinitionVersion(
  db: Db,
  input: {
    definitionId: number;
    definition: WorkflowDefinition;
    restoredFromVersion?: number;
    actor: WorkflowDefinitionActor;
  },
): Promise<WorkflowDefinitionVersionRow> {
  requireEditRole(input.actor.role);
  const definitionRows = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, input.definitionId))
    .limit(1);
  const definitionRow = definitionRows[0];
  if (!definitionRow) {
    throw new WorkflowDefinitionStoreError(404, "Unknown definition");
  }
  if (definitionRow.archivedAt) {
    throw new WorkflowDefinitionStoreError(409, "Definition is archived");
  }

  const triggerTypes = triggerTypesOf(input.definition);
  if (definitionRow.enabled) {
    await assertNoTriggerOverlap(db, { definitionId: input.definitionId, triggerTypes });
  }

  // Compute-then-insert the next version, retrying if a concurrent save took the
  // same number (the (definition_id, version) PK rejects the duplicate).
  const saved = await retryOnUniqueViolation(async () => {
    const [{ maxVersion }] = await db
      .select({ maxVersion: max(workflowDefinitionVersions.version) })
      .from(workflowDefinitionVersions)
      .where(eq(workflowDefinitionVersions.definitionId, input.definitionId));
    const next = (maxVersion ?? 0) + 1;
    const rows = await db
      .insert(workflowDefinitionVersions)
      .values({
        definitionId: input.definitionId,
        version: next,
        definition: input.definition,
        createdById: input.actor.id,
        createdByLabel: input.actor.label,
        restoredFromVersion: input.restoredFromVersion ?? null,
      })
      .returning();
    return rows[0]!;
  });

  await db
    .update(workflowDefinitions)
    .set({ triggerTypes, updatedAt: new Date() })
    .where(eq(workflowDefinitions.id, input.definitionId));

  return mapVersionRow(saved);
}

export async function updateWorkflowDefinition(
  db: Db,
  input: { definitionId: number; name?: string; enabled?: boolean; actor: WorkflowDefinitionActor },
): Promise<WorkflowDefinitionRow> {
  requireEditRole(input.actor.role);
  const rows = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, input.definitionId))
    .limit(1);
  const current = rows[0];
  if (!current) {
    throw new WorkflowDefinitionStoreError(404, "Unknown definition");
  }
  if (current.archivedAt) {
    throw new WorkflowDefinitionStoreError(409, "Definition is archived");
  }

  const set: { name?: string; enabled?: boolean; updatedAt?: Date } = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (Object.keys(set).length === 0) return mapDefinitionRow(current);

  if (input.enabled === true) {
    await assertNoTriggerOverlap(db, {
      definitionId: current.id,
      triggerTypes: current.triggerTypes as WorkflowBlockType[],
    });
  }

  set.updatedAt = new Date();
  let updated: DefinitionSelect;
  try {
    const res = await db
      .update(workflowDefinitions)
      .set(set)
      .where(eq(workflowDefinitions.id, input.definitionId))
      .returning();
    updated = res[0]!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkflowDefinitionStoreError(409, "Name already in use");
    }
    throw error;
  }
  return mapDefinitionRow(updated);
}

export async function archiveWorkflowDefinition(
  db: Db,
  input: { definitionId: number; actor: WorkflowDefinitionActor },
): Promise<WorkflowDefinitionRow> {
  requireEditRole(input.actor.role);
  const rows = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, input.definitionId))
    .limit(1);
  const current = rows[0];
  if (!current) {
    throw new WorkflowDefinitionStoreError(404, "Unknown definition");
  }
  if (current.archivedAt) return mapDefinitionRow(current);
  if (current.enabled) {
    throw new WorkflowDefinitionStoreError(409, "Disable the definition before archiving it");
  }

  const active = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(isNull(workflowDefinitions.archivedAt));
  if (active.length <= 1) {
    throw new WorkflowDefinitionStoreError(409, "Cannot archive the last workflow definition");
  }

  const res = await db
    .update(workflowDefinitions)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(workflowDefinitions.id, input.definitionId))
    .returning();
  return mapDefinitionRow(res[0]!);
}

export async function restoreWorkflowDefinitionVersion(
  db: Db,
  input: { definitionId: number; version: number; actor: WorkflowDefinitionActor },
): Promise<WorkflowDefinitionVersionRow> {
  requireEditRole(input.actor.role);
  const rows = await db
    .select()
    .from(workflowDefinitionVersions)
    .where(
      and(
        eq(workflowDefinitionVersions.definitionId, input.definitionId),
        eq(workflowDefinitionVersions.version, input.version),
      ),
    )
    .limit(1);
  const source = rows[0];
  if (!source) {
    throw new WorkflowDefinitionStoreError(404, "Unknown version");
  }
  return saveWorkflowDefinitionVersion(db, {
    definitionId: input.definitionId,
    definition: source.definition,
    restoredFromVersion: source.version,
    actor: input.actor,
  });
}

// --- Serialization ---

export function serializeWorkflowDefinitionVersion(
  row: WorkflowDefinitionVersionRow,
): WorkflowDefinitionVersion {
  return {
    version: row.version,
    definitionId: row.definitionId,
    definition: row.definition,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
}

// --- Back-compat wrappers (temporary; removed by stage B3) ---
//
// The pre-named-definition store had one global version log. These keep the old
// call sites (routes, definition-step.ts, their tests) working byte-for-byte by
// targeting the seeded default definition, and convert the new store error back
// to DashboardAuthError so the existing toHttpError mapping still applies.

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
    // DashboardAuthError (not the store error) so the READ wrappers, which have
    // no try/catch mapping, still surface a type toHttpError knows how to map.
    throw new DashboardAuthError(500, "No workflow definition");
  }
  return lowest[0].id;
}

function asDashboardAuthError(error: unknown): unknown {
  if (error instanceof WorkflowDefinitionStoreError) {
    return new DashboardAuthError(error.statusCode, error.message);
  }
  return error;
}

export async function getCurrentWorkflowDefinition(
  db: Db,
): Promise<WorkflowDefinitionVersionRow | null> {
  const definitionId = await resolveDefaultDefinitionId(db);
  return getCurrentWorkflowDefinitionVersion(db, definitionId);
}

export async function listWorkflowDefinitionVersions(
  db: Db,
): Promise<WorkflowDefinitionVersionRow[]> {
  const definitionId = await resolveDefaultDefinitionId(db);
  return listWorkflowDefinitionVersionRows(db, definitionId);
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
  const definitionId = await resolveDefaultDefinitionId(db);
  try {
    return await saveWorkflowDefinitionVersion(db, {
      definitionId,
      definition: input.definition,
      restoredFromVersion: input.restoredFromVersion,
      actor: { role: input.actorRole, id: input.actorId, label: input.actorLabel },
    });
  } catch (error) {
    throw asDashboardAuthError(error);
  }
}

export async function restoreWorkflowDefinition(
  db: Db,
  input: { actorRole: DashboardRole; actorId: string; actorLabel: string; version: number },
): Promise<WorkflowDefinitionVersionRow> {
  const definitionId = await resolveDefaultDefinitionId(db);
  try {
    return await restoreWorkflowDefinitionVersion(db, {
      definitionId,
      version: input.version,
      actor: { role: input.actorRole, id: input.actorId, label: input.actorLabel },
    });
  } catch (error) {
    throw asDashboardAuthError(error);
  }
}
