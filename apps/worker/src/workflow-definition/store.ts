import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionLayout,
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionVersion,
} from "@shared/contracts";
import { isTriggerBlockType } from "@shared/contracts";
import { and, arrayContains, arrayOverlaps, asc, desc, eq, isNull, max, ne, sql } from "drizzle-orm";
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
  validateWorkflowDefinitionIssuesForDeployment,
  workflowDefinitionSchema,
} from "./schema.js";
import { workflowBlockRegistryContextFromEnv } from "./models.js";
import {
  applyWorkflowDefinitionLayout,
  canonicalizeWorkflowDefinition,
  EMPTY_WORKFLOW_LAYOUT,
  extractWorkflowDefinitionLayout,
} from "./layout.js";

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

export interface WorkflowDefinitionVersionRow {
  definitionId: number;
  version: number;
  definition: WorkflowDefinition;
  createdAt: Date;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
}

/** Exact append-only JSON stored for a version, before compatibility reads
 * normalize legacy v1 shapes. Migration preflight uses this to ensure no
 * historical configuration is silently discarded. */
export interface RawWorkflowDefinitionVersionRow
  extends Omit<WorkflowDefinitionVersionRow, "definition"> {
  definition: unknown;
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
  if (!value || typeof value !== "object" || !("nodes" in value)) return EMPTY_WORKFLOW_LAYOUT;
  return value as WorkflowDefinitionLayout;
}

function mapDefinitionRow(
  row: DefinitionSelect,
  draftRevision = 0,
): WorkflowDefinitionRow {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
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
    definition: upgradeStoredWorkflowDefinition(row.definition),
    createdAt: row.createdAt,
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
}

function mapRawVersionRow(row: VersionSelect): RawWorkflowDefinitionVersionRow {
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
  const issues = validateWorkflowDefinitionIssuesForDeployment(
    parsed.data,
    workflowBlockRegistryContextFromEnv(),
    // This guard is used only when an already-stored snapshot is selected or
    // copied. Keep the v1 validation subset that was in force when that
    // immutable version was written. New deployments still pass through the
    // strict `assertDeployableDefinition` path below.
    { allowLegacyCompatibility: true },
  ).filter((issue) => issue.code !== "v2_runtime_unavailable");
  if (issues.length > 0) {
    throw new WorkflowDefinitionStoreError(
      400,
      `Invalid workflow: ${issues.map(({ message }) => message).join("; ")}`,
    );
  }
}

function assertDeployableDefinition(definition: WorkflowDefinition): void {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    throw new WorkflowDefinitionStoreError(
      400,
      `Invalid definition: ${describeWorkflowDefinitionIssues(parsed.error)}`,
    );
  }
  const issues = validateWorkflowDefinitionIssuesForDeployment(
    parsed.data,
    workflowBlockRegistryContextFromEnv(),
  );
  if (issues.length > 0) throw new WorkflowDefinitionValidationError(issues);
}

function parseStructuralDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    throw new WorkflowDefinitionStoreError(
      400,
      `Invalid definition: ${describeWorkflowDefinitionIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

function assertValidLayout(layout: WorkflowDefinitionLayout): void {
  if (!layout || typeof layout !== "object" || !layout.nodes || typeof layout.nodes !== "object") {
    throw new WorkflowDefinitionStoreError(400, "Invalid workflow layout");
  }
  for (const [nodeId, position] of Object.entries(layout.nodes)) {
    if (
      !nodeId ||
      !position ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y)
    ) {
      throw new WorkflowDefinitionStoreError(400, "Invalid workflow layout");
    }
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

function errorChainMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return messages.join(" ");
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
  return defs.map((row) => ({
    ...mapDefinitionRow(row, headByDefinition.get(row.id) ?? 0),
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
  const current = await getCurrentWorkflowDefinitionVersion(db, id);
  return mapDefinitionRow(rows[0], current?.version ?? 0);
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
  return mapDefinitionRow(row, currentVersion ?? 0);
}

export async function getWorkflowDefinitionDraft(
  db: Db,
  definitionId: number,
): Promise<WorkflowDefinitionDraftRow | null> {
  const [definition, current] = await Promise.all([
    getWorkflowDefinition(db, definitionId),
    getCurrentWorkflowDefinitionVersion(db, definitionId),
  ]);
  if (!definition || !current) return null;
  const semantic = upgradeStoredWorkflowDefinition(current.definition);
  return {
    definition,
    draft: applyWorkflowDefinitionLayout(semantic, definition.layout),
    draftRevision: current.version,
  };
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

/** Returns the exact immutable JSON blob without applying v1 compatibility
 * upgrades. This is intentionally separate from every normal read API. */
export async function getRawWorkflowDefinitionVersion(
  db: Db,
  definitionId: number,
  version: number,
): Promise<RawWorkflowDefinitionVersionRow | null> {
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
  return rows[0] ? mapRawVersionRow(rows[0]) : null;
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
  // Resolve the exact pointer observed with the definition row instead of
  // re-reading deployed_version in a second query. Version rows are immutable,
  // so this keeps the classification tied to one observed definition state.
  const current =
    defRow?.deployedVersion != null
      ? await getWorkflowDefinitionVersion(db, defRow.id, defRow.deployedVersion)
      : null;

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
    // Repair only while the definition still has the exact lifecycle state we
    // classified above. Deploy/rollback/enable replace the binding and update at
    // least one of these fields atomically; without this guard, a late cleanup
    // could delete their newly valid claim.
    const observedState = defRow
      ? sql`EXISTS (
          SELECT 1
          FROM ${workflowDefinitions}
          WHERE ${workflowDefinitions.id} = ${binding.definitionId}
            AND ${workflowDefinitions.enabled} = ${defRow.enabled}
            AND ${workflowDefinitions.archivedAt} IS NOT DISTINCT FROM ${defRow.archivedAt}
            AND ${workflowDefinitions.deployedVersion} IS NOT DISTINCT FROM ${defRow.deployedVersion}
        )`
      : sql`NOT EXISTS (
          SELECT 1
          FROM ${workflowDefinitions}
          WHERE ${workflowDefinitions.id} = ${binding.definitionId}
        )`;
    await db
      .delete(workflowDefinitionTriggers)
      .where(
        and(
          eq(workflowDefinitionTriggers.triggerType, triggerType),
          eq(workflowDefinitionTriggers.definitionId, binding.definitionId),
          observedState,
        ),
      )
      .catch(() => {});
    return null;
  }
  return { definition: mapDefinitionRow(defRow!, current?.version ?? 0), current };
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

export async function createWorkflowDefinition(
  db: Db,
  input: {
    name: string;
    seed: WorkflowDefinition | null;
    actor: WorkflowDefinitionActor;
    seedValidation?: "deployment" | "structural";
  },
): Promise<{ definition: WorkflowDefinitionRow; current: WorkflowDefinitionVersionRow | null }> {
  requireEditRole(input.actor.role);
  if (input.seed && input.seedValidation !== "structural") assertValidDefinition(input.seed);
  const parsedSeed = input.seed
    ? input.seedValidation === "structural"
      ? parseStructuralDefinition(input.seed)
      : input.seed
    : null;
  const semantic = parsedSeed ? canonicalizeWorkflowDefinition(parsedSeed) : null;
  const layout = input.seed ? extractWorkflowDefinitionLayout(input.seed) : EMPTY_WORKFLOW_LAYOUT;
  let created: DefinitionSelect;
  try {
    const rows = await db
      .insert(workflowDefinitions)
      .values({
        name: input.name,
        enabled: false,
        triggerTypes: [],
        layout,
        layoutRevision: input.seed ? 1 : 0,
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
  if (semantic) {
    try {
      const versions = await db
        .insert(workflowDefinitionVersions)
        .values({
          definitionId: created.id,
          version: 1,
          definition: semantic,
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
  return { definition: mapDefinitionRow(created, current?.version ?? 0), current };
}

/** Creates an editor-owned semantic draft without manufacturing a deployment. */
export async function createWorkflowDefinitionDraft(
  db: Db,
  input: { name: string; seed: WorkflowDefinition; actor: WorkflowDefinitionActor },
): Promise<WorkflowDefinitionDraftRow> {
  const parsed = parseStructuralDefinition(input.seed);
  const created = await createWorkflowDefinition(db, {
    ...input,
    seed: parsed,
    seedValidation: "structural",
  });
  if (!created.current) {
    throw new WorkflowDefinitionStoreError(500, "Created definition version was not readable");
  }
  return {
    definition: created.definition,
    draft: applyWorkflowDefinitionLayout(created.current.definition, created.definition.layout),
    draftRevision: created.current.version,
  };
}

function triggerArraySql(triggerTypes: WorkflowBlockType[]) {
  if (triggerTypes.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(triggerTypes.map((trigger) => sql`${trigger}`), sql`, `)}]::text[]`;
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export async function saveWorkflowDefinitionDraft(
  db: Db,
  input: {
    definitionId: number;
    definition: WorkflowDefinition;
    expectedDraftRevision: number;
    actor: WorkflowDefinitionActor;
  },
): Promise<WorkflowDefinitionDraftRow> {
  requireEditRole(input.actor.role);
  const semantic = canonicalizeWorkflowDefinition(parseStructuralDefinition(input.definition));
  let selected: { id: number; version: number } | undefined;
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
        SELECT c.id, ${input.expectedDraftRevision + 1}, ${JSON.stringify(semantic)}::jsonb,
          ${input.actor.id}, ${input.actor.label}, NULL
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
    selected = rawRows<{ id: number; version: number }>(result)[0];
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  if (!selected) {
    const current = await getWorkflowDefinition(db, input.definitionId);
    if (!current) throw new WorkflowDefinitionStoreError(404, "Unknown definition");
    if (current.archivedAt) throw new WorkflowDefinitionStoreError(409, "Definition is archived");
    throw new WorkflowDefinitionStoreError(409, "Draft changed; reload before saving");
  }
  const [definition, version] = await Promise.all([
    getWorkflowDefinition(db, selected.id),
    getWorkflowDefinitionVersion(db, selected.id, selected.version),
  ]);
  if (!definition || !version) {
    throw new WorkflowDefinitionStoreError(500, "Saved definition version was not readable");
  }
  return {
    definition,
    draft: applyWorkflowDefinitionLayout(version.definition, definition.layout),
    draftRevision: version.version,
  };
}

export async function saveWorkflowDefinitionLayout(
  db: Db,
  input: {
    definitionId: number;
    layout: WorkflowDefinitionLayout;
    expectedLayoutRevision: number;
    actor: WorkflowDefinitionActor;
  },
): Promise<WorkflowDefinitionRow> {
  requireEditRole(input.actor.role);
  assertValidLayout(input.layout);
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
  const saved = rows[0];
  if (!saved) {
    const current = await getWorkflowDefinition(db, input.definitionId);
    if (!current) throw new WorkflowDefinitionStoreError(404, "Unknown definition");
    if (current.archivedAt) throw new WorkflowDefinitionStoreError(409, "Definition is archived");
    throw new WorkflowDefinitionStoreError(409, "Layout changed; reload before saving");
  }
  const current = await getCurrentWorkflowDefinitionVersion(db, input.definitionId);
  return mapDefinitionRow(saved, current?.version ?? 0);
}

export interface WorkflowDefinitionSelectionResult {
  definition: WorkflowDefinitionRow;
  version: WorkflowDefinitionVersionRow;
}

export async function deployWorkflowDefinition(
  db: Db,
  input: {
    definitionId: number;
    expectedDraftRevision: number;
    expectedDeployedVersion: number | null;
    actor: WorkflowDefinitionActor;
  },
): Promise<WorkflowDefinitionSelectionResult> {
  requireEditRole(input.actor.role);
  const current = await getWorkflowDefinition(db, input.definitionId);
  if (!current) throw new WorkflowDefinitionStoreError(404, "Unknown definition");
  if (current.archivedAt) throw new WorkflowDefinitionStoreError(409, "Definition is archived");
  if (current.draftRevision === 0) {
    throw new WorkflowDefinitionStoreError(409, "Save a draft before deploying");
  }
  if (
    current.draftRevision !== input.expectedDraftRevision ||
    current.deployedVersion !== input.expectedDeployedVersion
  ) {
    throw new WorkflowDefinitionStoreError(409, "Definition changed; reload before deploying");
  }

  const target = await getWorkflowDefinitionVersion(
    db,
    input.definitionId,
    input.expectedDraftRevision,
  );
  if (!target) throw new WorkflowDefinitionStoreError(409, "Save a draft before deploying");
  assertDeployableDefinition(target.definition);
  const triggerTypes = triggerTypesOf(target.definition);
  const triggerArray = triggerArraySql(triggerTypes);

  try {
    const result = await db.execute(sql`
      WITH candidate AS (
        SELECT wd.id, wd.enabled
        FROM workflow_definitions wd
        WHERE wd.id = ${input.definitionId}
          AND wd.archived_at IS NULL
          AND wd.deployed_version IS NOT DISTINCT FROM ${input.expectedDeployedVersion}
          AND COALESCE((
            SELECT MAX(v.version)
            FROM workflow_definition_versions v
            WHERE v.definition_id = wd.id
          ), 0) = ${input.expectedDraftRevision}
        FOR UPDATE
      ), deleted_claims AS (
        DELETE FROM workflow_definition_triggers
        WHERE definition_id IN (SELECT id FROM candidate)
        RETURNING trigger_type
      ), inserted_claims AS (
        INSERT INTO workflow_definition_triggers (trigger_type, definition_id)
        SELECT trigger_type, c.id
        FROM candidate c
        CROSS JOIN LATERAL unnest(${triggerArray}) AS trigger_type
        CROSS JOIN (SELECT count(*) FROM deleted_claims) AS delete_barrier
        WHERE c.enabled
        RETURNING trigger_type
      ), claim_barrier AS (
        SELECT count(*) AS count FROM inserted_claims
      ), updated AS (
        UPDATE workflow_definitions wd
        SET deployed_version = ${input.expectedDraftRevision},
            trigger_types = ${triggerArray},
            updated_at = now()
        FROM candidate c
        CROSS JOIN claim_barrier
        WHERE wd.id = c.id
        RETURNING wd.id, wd.deployed_version AS version
      )
      SELECT id, version FROM updated
    `);
    const selected = rawRows<{ id: number; version: number }>(result)[0];
    if (!selected) {
      throw new WorkflowDefinitionStoreError(409, "Definition changed; reload before deploying");
    }
    const [definition, version] = await Promise.all([
      getWorkflowDefinition(db, selected.id),
      getWorkflowDefinitionVersion(db, selected.id, selected.version),
    ]);
    if (!definition || !version) {
      throw new WorkflowDefinitionStoreError(500, "Deployment selection was not readable");
    }
    return { definition, version };
  } catch (error) {
    if (error instanceof WorkflowDefinitionStoreError) throw error;
    if (isUniqueViolation(error)) {
      throw new WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
    }
    throw error;
  }
}

export async function rollbackWorkflowDefinition(
  db: Db,
  input: {
    definitionId: number;
    version: number;
    expectedDeployedVersion: number | null;
    actor: WorkflowDefinitionActor;
  },
): Promise<WorkflowDefinitionSelectionResult> {
  requireEditRole(input.actor.role);
  const [current, target] = await Promise.all([
    getWorkflowDefinition(db, input.definitionId),
    getWorkflowDefinitionVersion(db, input.definitionId, input.version),
  ]);
  if (!current) throw new WorkflowDefinitionStoreError(404, "Unknown definition");
  if (current.archivedAt) throw new WorkflowDefinitionStoreError(409, "Definition is archived");
  if (!target) throw new WorkflowDefinitionStoreError(404, "Unknown version");
  if (current.deployedVersion !== input.expectedDeployedVersion) {
    throw new WorkflowDefinitionStoreError(409, "Definition changed; reload before rolling back");
  }
  if (target.definition.schemaVersion === 2) {
    assertDeployableDefinition(target.definition);
  } else {
    assertValidDefinition(target.definition);
  }
  const triggerTypes = triggerTypesOf(target.definition);
  const triggerArray = triggerArraySql(triggerTypes);

  try {
    const result = await db.execute(sql`
      WITH candidate AS (
        SELECT id, enabled, deployed_version
        FROM workflow_definitions
        WHERE id = ${input.definitionId}
          AND archived_at IS NULL
          AND deployed_version IS NOT DISTINCT FROM ${input.expectedDeployedVersion}
        FOR UPDATE
      ), target AS (
        SELECT c.id, c.enabled, c.deployed_version, v.version
        FROM candidate c
        JOIN workflow_definition_versions v
          ON v.definition_id = c.id AND v.version = ${input.version}
      ), deleted_claims AS (
        DELETE FROM workflow_definition_triggers
        WHERE definition_id IN (SELECT id FROM target)
        RETURNING trigger_type
      ), inserted_claims AS (
        INSERT INTO workflow_definition_triggers (trigger_type, definition_id)
        SELECT trigger_type, t.id
        FROM target t
        CROSS JOIN LATERAL unnest(${triggerArray}) AS trigger_type
        CROSS JOIN (SELECT count(*) FROM deleted_claims) AS delete_barrier
        WHERE t.enabled
        RETURNING trigger_type
      ), claim_barrier AS (
        SELECT count(*) AS count FROM inserted_claims
      ), updated AS (
        UPDATE workflow_definitions wd
        SET deployed_version = t.version,
            trigger_types = ${triggerArray},
            updated_at = now()
        FROM target t
        CROSS JOIN claim_barrier
        WHERE wd.id = t.id
        RETURNING wd.id, t.version
      )
      SELECT id, version FROM updated
    `);
    const selected = rawRows<{ id: number; version: number }>(result)[0];
    if (!selected) {
      throw new WorkflowDefinitionStoreError(409, "Definition changed; reload before rolling back");
    }
    const definition = await getWorkflowDefinition(db, selected.id);
    if (!definition) {
      throw new WorkflowDefinitionStoreError(500, "Rollback selection was not readable");
    }
    return { definition, version: target };
  } catch (error) {
    if (error instanceof WorkflowDefinitionStoreError) throw error;
    if (isUniqueViolation(error)) {
      throw new WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
    }
    throw error;
  }
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
  // Deprecated compatibility helper. It may append an immutable snapshot for
  // old internal callers, but it must never select that snapshot or mutate live
  // trigger ownership. Dashboard/API saves use saveWorkflowDefinitionDraft.
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

  const set: { name?: string; updatedAt?: Date } = {};
  if (input.name !== undefined) set.name = input.name;
  if (Object.keys(set).length === 0 && input.enabled === undefined) {
    return (await getWorkflowDefinition(db, current.id))!;
  }

  if (input.enabled !== undefined) {
    let triggerTypes: WorkflowBlockType[] = [];
    if (input.enabled) {
      if (current.deployedVersion != null) {
        const deployed = await getWorkflowDefinitionVersion(
          db,
          current.id,
          current.deployedVersion,
        );
        if (!deployed) {
          throw new WorkflowDefinitionStoreError(409, "The deployed version is unavailable");
        }
        if (deployed.definition.schemaVersion === 2) {
          assertDeployableDefinition(deployed.definition);
        } else {
          assertValidDefinition(deployed.definition);
        }
        triggerTypes = triggerTypesOf(deployed.definition);
      } else {
        const latest = await getCurrentWorkflowDefinitionVersion(db, current.id);
        const isFreshInstallFallback =
          latest === null &&
          current.triggerTypes.length === 1 &&
          current.triggerTypes[0] === "trigger_ticket_ai";
        if (!isFreshInstallFallback) {
          throw new WorkflowDefinitionStoreError(409, "Deploy a valid draft before enabling");
        }
        triggerTypes = ["trigger_ticket_ai"];
      }
      await assertNoTriggerOverlap(db, { definitionId: current.id, triggerTypes });
    }

    const triggerArray = triggerArraySql(triggerTypes);
    try {
      const result = await db.execute(sql`
        WITH candidate AS (
          SELECT id
          FROM workflow_definitions
          WHERE id = ${current.id}
            AND archived_at IS NULL
            AND deployed_version IS NOT DISTINCT FROM ${current.deployedVersion}
            AND trigger_types = ${triggerArraySql(current.triggerTypes as WorkflowBlockType[])}
          FOR UPDATE
        ), deleted_claims AS (
          DELETE FROM workflow_definition_triggers
          WHERE definition_id IN (SELECT id FROM candidate)
          RETURNING trigger_type
        ), inserted_claims AS (
          INSERT INTO workflow_definition_triggers (trigger_type, definition_id)
          SELECT trigger_type, c.id
          FROM candidate c
          CROSS JOIN LATERAL unnest(${triggerArray}) AS trigger_type
          CROSS JOIN (SELECT count(*) FROM deleted_claims) AS delete_barrier
          WHERE ${input.enabled}
          RETURNING trigger_type
        ), claim_barrier AS (
          SELECT count(*) AS count FROM inserted_claims
        ), updated AS (
          UPDATE workflow_definitions wd
          SET enabled = ${input.enabled},
              name = ${input.name === undefined ? sql`wd.name` : sql`${input.name}`},
              updated_at = now()
          FROM candidate c
          CROSS JOIN claim_barrier
          WHERE wd.id = c.id
          RETURNING wd.id
        )
        SELECT id FROM updated
      `);
      const updatedId = rawRows<{ id: number }>(result)[0]?.id;
      if (!updatedId) {
        throw new WorkflowDefinitionStoreError(409, "Definition changed; reload before updating");
      }
      const updated = await getWorkflowDefinition(db, updatedId);
      if (!updated) throw new WorkflowDefinitionStoreError(404, "Unknown definition");
      return updated;
    } catch (error) {
      if (error instanceof WorkflowDefinitionStoreError) throw error;
      if (isUniqueViolation(error)) {
        if (/workflow_definitions_name_active_idx/i.test(errorChainMessage(error))) {
          throw new WorkflowDefinitionStoreError(409, "Name already in use");
        }
        throw new WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
      }
      throw error;
    }
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

  return (await getWorkflowDefinition(db, updated.id))!;
}

export async function archiveWorkflowDefinition(
  db: Db,
  input: { definitionId: number; actor: WorkflowDefinitionActor },
): Promise<WorkflowDefinitionRow> {
  requireEditRole(input.actor.role);
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

  const archivedId = rawRows<{ id: number }>(result)[0]?.id;
  const current = await getWorkflowDefinition(db, input.definitionId);
  if (!current) {
    throw new WorkflowDefinitionStoreError(404, "Unknown definition");
  }
  if (archivedId !== undefined || current.archivedAt) return current;
  if (current.enabled) {
    throw new WorkflowDefinitionStoreError(409, "Disable the definition before archiving it");
  }
  if ((await listWorkflowDefinitions(db)).length <= 1) {
    throw new WorkflowDefinitionStoreError(409, "Cannot archive the last workflow definition");
  }
  throw new WorkflowDefinitionStoreError(409, "Definition changed; reload before archiving");
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

export async function resolveDefaultDefinitionId(db: Db): Promise<number> {
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
