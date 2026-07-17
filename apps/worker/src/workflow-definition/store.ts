import type { WorkflowBlockType, WorkflowDefinition, WorkflowDefinitionVersion } from "@shared/contracts";
import { isTriggerBlockType } from "@shared/contracts";
import { and, arrayContains, arrayOverlaps, asc, desc, eq, inArray, isNull, max, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  workflowDefinitions,
  workflowDefinitionTriggers,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { canEditWorkflowDefinitions, type DashboardRole } from "../lib/auth/roles.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";
import {
  describeWorkflowDefinitionIssues,
  upgradeStoredWorkflowDefinition,
  validateWorkflowDefinitionForDeployment,
  workflowDefinitionSchema,
} from "./schema.js";
import { workflowBlockRegistryContextFromEnv } from "./models.js";

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
    definition: upgradeStoredWorkflowDefinition(row.definition),
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

/** Gate every write on a loadable graph. The PUT routes validate first and shape
 *  their own 400s, so this never fires for them; it exists for the paths that
 *  feed a stored blob straight back in (restore, duplicate-create), where an
 *  older version can fail today's schema and would install a head the runtime
 *  silently replaces with the built-in default. Message text matches the routes'.
 * Reads skip current deploy rules, but still pass through deterministic stored
 * shape upgrades. Known retired shapes remain readable; truly unknown block
 * types stay rejected instead of being guessed or silently discarded. */
function assertValidDefinition(definition: WorkflowDefinition): void {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    throw new WorkflowDefinitionStoreError(
      400,
      `Invalid definition: ${describeWorkflowDefinitionIssues(parsed.error)}`,
    );
  }
  const issues = validateWorkflowDefinitionForDeployment(
    parsed.data,
    workflowBlockRegistryContextFromEnv(),
  );
  if (issues.length > 0) {
    throw new WorkflowDefinitionStoreError(400, `Invalid workflow: ${issues.join("; ")}`);
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
  // Route via the enabled trigger binding (its trigger_type PK guarantees at
  // most one owner), then reconcile against the head graph. A crashed
  // enable/disable/save can leave a binding pointing at a definition that is no
  // longer enabled, is archived, or whose head version no longer declares this
  // trigger; repair such drift by dropping the stale binding and reporting no
  // match. Deriving the trigger set from the stored version keeps dispatch
  // consistent with the graph head even when the denormalized trigger_types
  // column drifts (a write that crashed between the version insert and the
  // column update).
  const bindingRows = await db
    .select({ definitionId: workflowDefinitionTriggers.definitionId })
    .from(workflowDefinitionTriggers)
    .where(eq(workflowDefinitionTriggers.triggerType, triggerType))
    .limit(1);
  const binding = bindingRows[0];
  if (!binding) return null;

  const defRows = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, binding.definitionId))
    .limit(1);
  const defRow = defRows[0];
  const current = defRow ? await getCurrentWorkflowDefinitionVersion(db, defRow.id) : null;

  // A definition with no versions falls back to the built-in default, whose
  // trigger_types column is fixed at seed time and cannot drift from a version.
  const actualTriggers: WorkflowBlockType[] = current
    ? triggerTypesOf(current.definition)
    : ((defRow?.triggerTypes as WorkflowBlockType[]) ?? []);
  const stale =
    !defRow ||
    !defRow.enabled ||
    defRow.archivedAt != null ||
    !actualTriggers.includes(triggerType);
  if (stale) {
    await db
      .delete(workflowDefinitionTriggers)
      .where(
        and(
          eq(workflowDefinitionTriggers.triggerType, triggerType),
          eq(workflowDefinitionTriggers.definitionId, binding.definitionId),
        ),
      )
      .catch(() => {});
    return null;
  }
  return { definition: mapDefinitionRow(defRow!), current };
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

/** 409 message the DB-level bindings raise when another enabled definition
 *  already owns one of the triggers (the race the friendly precheck can miss). */
const TRIGGER_TAKEN_MESSAGE = "Its trigger is already handled by another enabled definition";

/** Claims the enabled trigger bindings for `triggerTypes` under `definitionId`,
 *  mapping the trigger_type unique violation (another enabled definition already
 *  owns one) to the 409 the routes surface. Clears this definition's own rows
 *  first so a retry after a crashed enable can't self-conflict. No-op for an
 *  empty trigger set (a definition with no trigger can still be enabled). */
async function claimEnabledTriggers(
  db: Db,
  definitionId: number,
  triggerTypes: WorkflowBlockType[],
): Promise<void> {
  await db
    .delete(workflowDefinitionTriggers)
    .where(eq(workflowDefinitionTriggers.definitionId, definitionId));
  if (triggerTypes.length === 0) return;
  try {
    await db
      .insert(workflowDefinitionTriggers)
      .values(triggerTypes.map((triggerType) => ({ triggerType, definitionId })));
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
    }
    throw error;
  }
}

/** Reconciles an ENABLED definition's trigger bindings to `newTriggers` after a
 *  new version changed its trigger set: drops the ones it no longer declares and
 *  inserts the newly added ones, mapping a collision on an added trigger to the
 *  409. A disabled definition owns no bindings, so its caller skips this. */
async function syncEnabledTriggersOnSave(
  db: Db,
  definitionId: number,
  newTriggers: WorkflowBlockType[],
): Promise<void> {
  const existingRows = await db
    .select({ triggerType: workflowDefinitionTriggers.triggerType })
    .from(workflowDefinitionTriggers)
    .where(eq(workflowDefinitionTriggers.definitionId, definitionId));
  const existing = new Set(existingRows.map((r) => r.triggerType));
  const next = new Set<string>(newTriggers);
  const toRemove = [...existing].filter((t) => !next.has(t));
  const toAdd = newTriggers.filter((t) => !existing.has(t));
  if (toRemove.length > 0) {
    await db
      .delete(workflowDefinitionTriggers)
      .where(
        and(
          eq(workflowDefinitionTriggers.definitionId, definitionId),
          inArray(workflowDefinitionTriggers.triggerType, toRemove),
        ),
      );
  }
  if (toAdd.length > 0) {
    try {
      await db
        .insert(workflowDefinitionTriggers)
        .values(toAdd.map((triggerType) => ({ triggerType, definitionId })));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
      }
      throw error;
    }
  }
}

export async function createWorkflowDefinition(
  db: Db,
  input: { name: string; seed: WorkflowDefinition | null; actor: WorkflowDefinitionActor },
): Promise<{ definition: WorkflowDefinitionRow; current: WorkflowDefinitionVersionRow | null }> {
  requireEditRole(input.actor.role);
  if (input.seed) assertValidDefinition(input.seed);
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
  assertValidDefinition(input.definition);
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

  // Safe order: the version is the source of truth, the enabled trigger bindings
  // are the dispatch metadata derived from it, and trigger_types is a display
  // copy. Sync the bindings to the new head (only an enabled definition owns any)
  // before refreshing the display copy, so a crash never leaves the bindings
  // promising a trigger the head graph dropped. getEnabledWorkflowDefinitionForTrigger
  // reconciles any residual drift on read.
  if (definitionRow.enabled) {
    await syncEnabledTriggersOnSave(db, input.definitionId, triggerTypes);
  }

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
    // Friendly precheck (names the conflicting definition) followed by the
    // atomic guard: claiming the trigger bindings trips the trigger_type PK if
    // another enabled definition already owns one, closing the read-then-write
    // race two concurrent enables would otherwise both slip through. Claimed
    // before the row flips so the binding — not the enabled flag — is the point
    // that serializes; a crash after this heals via reconcile-on-read.
    await assertNoTriggerOverlap(db, {
      definitionId: current.id,
      triggerTypes: current.triggerTypes as WorkflowBlockType[],
    });
    await claimEnabledTriggers(db, current.id, current.triggerTypes as WorkflowBlockType[]);
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

  if (input.enabled === false) {
    // Release the bindings only after the row is disabled, so the trigger is
    // never briefly free while this definition still reads as enabled.
    await db
      .delete(workflowDefinitionTriggers)
      .where(eq(workflowDefinitionTriggers.definitionId, current.id));
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
  // Defensive: a disabled definition owns no bindings, but drop any a crashed
  // disable left behind so an archived definition never keeps a trigger.
  await db
    .delete(workflowDefinitionTriggers)
    .where(eq(workflowDefinitionTriggers.definitionId, input.definitionId));
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
    definition: mapVersionRow(source).definition,
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
