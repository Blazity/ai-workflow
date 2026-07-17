import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionDeployment,
  WorkflowDefinitionDeploymentAction,
  WorkflowDefinitionLayout,
  WorkflowDefinitionVersion,
} from "@shared/contracts";
import { isTriggerBlockType } from "@shared/contracts";
import { and, arrayContains, arrayOverlaps, asc, desc, eq, isNull, max, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  workflowDefinitions,
  workflowDefinitionDeployments,
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
  builtinFallback: boolean;
  triggerTypes: WorkflowBlockType[];
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

export interface WorkflowDefinitionDeploymentRow {
  id: number;
  definitionId: number;
  selectedVersion: number;
  previousVersion: number | null;
  action: WorkflowDefinitionDeploymentAction;
  rollbackFromVersion: number | null;
  createdAt: Date;
  createdById: string;
  createdByLabel: string;
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
type DeploymentSelect = typeof workflowDefinitionDeployments.$inferSelect;

function normalizeLayout(value: unknown): WorkflowDefinitionLayout {
  if (!value || typeof value !== "object" || !("nodes" in value)) return EMPTY_WORKFLOW_LAYOUT;
  return value as WorkflowDefinitionLayout;
}

function mapDefinitionRow(row: DefinitionSelect): WorkflowDefinitionRow {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    builtinFallback: row.builtinFallback,
    triggerTypes: row.triggerTypes as WorkflowBlockType[],
    draftRevision: row.draftRevision,
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

function mapDeploymentRow(row: DeploymentSelect): WorkflowDefinitionDeploymentRow {
  return {
    id: row.id,
    definitionId: row.definitionId,
    selectedVersion: row.selectedVersion,
    previousVersion: row.previousVersion,
    action: row.action as WorkflowDefinitionDeploymentAction,
    rollbackFromVersion: row.rollbackFromVersion,
    createdAt: row.createdAt,
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
  return defs.map((row) => ({
    ...mapDefinitionRow(row),
    // `currentVersion` remains only as a deprecated API alias. It must name
    // the version selected for execution, never an unselected history head.
    currentVersion: row.deployedVersion,
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

export async function getWorkflowDefinitionDraft(
  db: Db,
  definitionId: number,
): Promise<WorkflowDefinitionDraftRow | null> {
  const rows = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, definitionId))
    .limit(1);
  const row = rows[0];
  if (!row?.draft) return null;
  const semantic = upgradeStoredWorkflowDefinition(row.draft);
  return {
    definition: mapDefinitionRow(row),
    draft: applyWorkflowDefinitionLayout(semantic, normalizeLayout(row.layout)),
    draftRevision: row.draftRevision,
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

export async function listWorkflowDefinitionDeployments(
  db: Db,
  definitionId: number,
): Promise<WorkflowDefinitionDeploymentRow[]> {
  const rows = await db
    .select()
    .from(workflowDefinitionDeployments)
    .where(eq(workflowDefinitionDeployments.definitionId, definitionId))
    .orderBy(desc(workflowDefinitionDeployments.id))
    .limit(VERSION_LIST_LIMIT);
  return rows.map(mapDeploymentRow);
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
  const isSeedFallback = defRow?.builtinFallback === true && triggerType === "trigger_ticket_ai";
  const actualTriggers: WorkflowBlockType[] = current
    ? triggerTypesOf(current.definition)
    : isSeedFallback
      ? (["trigger_ticket_ai"] as WorkflowBlockType[])
      : [];
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
            AND ${workflowDefinitions.builtinFallback} = ${defRow.builtinFallback}
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

/** Creates an editor-owned semantic draft without manufacturing a deployment. */
export async function createWorkflowDefinitionDraft(
  db: Db,
  input: { name: string; seed: WorkflowDefinition; actor: WorkflowDefinitionActor },
): Promise<WorkflowDefinitionDraftRow> {
  requireEditRole(input.actor.role);
  const parsed = parseStructuralDefinition(input.seed);
  const draft = canonicalizeWorkflowDefinition(parsed);
  const layout = extractWorkflowDefinitionLayout(parsed);
  try {
    const rows = await db
      .insert(workflowDefinitions)
      .values({
        name: input.name,
        enabled: false,
        triggerTypes: [],
        draft,
        draftRevision: 1,
        layout,
        layoutRevision: 1,
        deployedVersion: null,
        createdById: input.actor.id,
        createdByLabel: input.actor.label,
      })
      .returning();
    const row = rows[0]!;
    return {
      definition: mapDefinitionRow(row),
      draft: applyWorkflowDefinitionLayout(draft, layout),
      draftRevision: row.draftRevision,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkflowDefinitionStoreError(409, "Name already in use");
    }
    throw error;
  }
}

function triggerArraySql(triggerTypes: WorkflowBlockType[]) {
  if (triggerTypes.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(triggerTypes.map((trigger) => sql`${trigger}`), sql`, `)}]::text[]`;
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

async function getWorkflowDefinitionDeployment(
  db: Db,
  id: number,
): Promise<WorkflowDefinitionDeploymentRow | null> {
  const rows = await db
    .select()
    .from(workflowDefinitionDeployments)
    .where(eq(workflowDefinitionDeployments.id, id))
    .limit(1);
  return rows[0] ? mapDeploymentRow(rows[0]) : null;
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
  const rows = await db
    .update(workflowDefinitions)
    .set({
      draft: semantic,
      draftRevision: sql`${workflowDefinitions.draftRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowDefinitions.id, input.definitionId),
        eq(workflowDefinitions.draftRevision, input.expectedDraftRevision),
        isNull(workflowDefinitions.archivedAt),
      ),
    )
    .returning();
  const saved = rows[0];
  if (!saved) {
    const current = await getWorkflowDefinition(db, input.definitionId);
    if (!current) throw new WorkflowDefinitionStoreError(404, "Unknown definition");
    if (current.archivedAt) throw new WorkflowDefinitionStoreError(409, "Definition is archived");
    throw new WorkflowDefinitionStoreError(409, "Draft changed; reload before saving");
  }
  return {
    definition: mapDefinitionRow(saved),
    draft: applyWorkflowDefinitionLayout(semantic, normalizeLayout(saved.layout)),
    draftRevision: saved.draftRevision,
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
  return mapDefinitionRow(saved);
}

export interface WorkflowDefinitionSelectionResult {
  definition: WorkflowDefinitionRow;
  version: WorkflowDefinitionVersionRow;
  deployment: WorkflowDefinitionDeploymentRow;
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
  const rows = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, input.definitionId))
    .limit(1);
  const current = rows[0];
  if (!current) throw new WorkflowDefinitionStoreError(404, "Unknown definition");
  if (current.archivedAt) throw new WorkflowDefinitionStoreError(409, "Definition is archived");
  if (!current.draft) throw new WorkflowDefinitionStoreError(409, "Save a draft before deploying");
  if (
    current.draftRevision !== input.expectedDraftRevision ||
    current.deployedVersion !== input.expectedDeployedVersion
  ) {
    throw new WorkflowDefinitionStoreError(409, "Definition changed; reload before deploying");
  }

  const draft = upgradeStoredWorkflowDefinition(current.draft);
  assertValidDefinition(draft);
  const triggerTypes = triggerTypesOf(draft);
  const triggerArray = triggerArraySql(triggerTypes);

  try {
    const result = await db.execute(sql`
      WITH candidate AS (
        SELECT id, enabled, deployed_version
        FROM workflow_definitions
        WHERE id = ${input.definitionId}
          AND archived_at IS NULL
          AND draft_revision = ${input.expectedDraftRevision}
          AND deployed_version IS NOT DISTINCT FROM ${input.expectedDeployedVersion}
        FOR UPDATE
      ), numbered AS (
        SELECT c.id, c.enabled, c.deployed_version,
          COALESCE(MAX(v.version), 0)::integer + 1 AS version
        FROM candidate c
        LEFT JOIN workflow_definition_versions v ON v.definition_id = c.id
        GROUP BY c.id, c.enabled, c.deployed_version
      ), inserted_version AS (
        INSERT INTO workflow_definition_versions
          (definition_id, version, definition, created_by_id, created_by_label, restored_from_version)
        SELECT n.id, n.version, ${JSON.stringify(draft)}::jsonb,
          ${input.actor.id}, ${input.actor.label}, NULL
        FROM numbered n
        RETURNING definition_id, version
      ), deleted_claims AS (
        DELETE FROM workflow_definition_triggers
        WHERE definition_id IN (SELECT id FROM numbered)
        RETURNING trigger_type
      ), inserted_claims AS (
        INSERT INTO workflow_definition_triggers (trigger_type, definition_id)
        SELECT trigger_type, n.id
        FROM numbered n
        CROSS JOIN LATERAL unnest(${triggerArray}) AS trigger_type
        CROSS JOIN (SELECT count(*) FROM deleted_claims) AS delete_barrier
        WHERE n.enabled
        RETURNING trigger_type
      ), claim_barrier AS (
        SELECT count(*) AS count FROM inserted_claims
      ), inserted_history AS (
        INSERT INTO workflow_definition_deployments
          (definition_id, selected_version, previous_version, action, rollback_from_version,
           created_by_id, created_by_label)
        SELECT n.id, iv.version, n.deployed_version, 'deploy', NULL,
          ${input.actor.id}, ${input.actor.label}
        FROM numbered n
        JOIN inserted_version iv ON iv.definition_id = n.id
        CROSS JOIN claim_barrier
        RETURNING id, definition_id, selected_version
      ), updated AS (
        UPDATE workflow_definitions wd
        SET deployed_version = iv.version,
            trigger_types = ${triggerArray},
            builtin_fallback = false,
            updated_at = now()
        FROM inserted_version iv
        JOIN inserted_history h ON h.definition_id = iv.definition_id
        WHERE wd.id = iv.definition_id
        RETURNING wd.id, iv.version, h.id AS history_id
      )
      SELECT id, version, history_id FROM updated
    `);
    const selected = rawRows<{ id: number; version: number; history_id: number }>(result)[0];
    if (!selected) {
      throw new WorkflowDefinitionStoreError(409, "Definition changed; reload before deploying");
    }
    const [definition, version, deployment] = await Promise.all([
      getWorkflowDefinition(db, selected.id),
      getWorkflowDefinitionVersion(db, selected.id, selected.version),
      getWorkflowDefinitionDeployment(db, selected.history_id),
    ]);
    if (!definition || !version || !deployment) {
      throw new WorkflowDefinitionStoreError(500, "Deployment selection was not readable");
    }
    return { definition, version, deployment };
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
  assertValidDefinition(target.definition);
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
      ), inserted_history AS (
        INSERT INTO workflow_definition_deployments
          (definition_id, selected_version, previous_version, action, rollback_from_version,
           created_by_id, created_by_label)
        SELECT t.id, t.version, t.deployed_version, 'rollback', t.deployed_version,
          ${input.actor.id}, ${input.actor.label}
        FROM target t
        CROSS JOIN claim_barrier
        RETURNING id, definition_id, selected_version
      ), updated AS (
        UPDATE workflow_definitions wd
        SET deployed_version = t.version,
            trigger_types = ${triggerArray},
            builtin_fallback = false,
            updated_at = now()
        FROM target t
        JOIN inserted_history h ON h.definition_id = t.id
        WHERE wd.id = t.id
        RETURNING wd.id, t.version, h.id AS history_id
      )
      SELECT id, version, history_id FROM updated
    `);
    const selected = rawRows<{ id: number; version: number; history_id: number }>(result)[0];
    if (!selected) {
      throw new WorkflowDefinitionStoreError(409, "Definition changed; reload before rolling back");
    }
    const [definition, deployment] = await Promise.all([
      getWorkflowDefinition(db, selected.id),
      getWorkflowDefinitionDeployment(db, selected.history_id),
    ]);
    if (!definition || !deployment) {
      throw new WorkflowDefinitionStoreError(500, "Rollback selection was not readable");
    }
    return { definition, version: target, deployment };
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
  if (Object.keys(set).length === 0 && input.enabled === undefined) return mapDefinitionRow(current);

  if (input.enabled !== undefined) {
    let triggerTypes: WorkflowBlockType[] = [];
    if (input.enabled) {
      if (current.deployedVersion == null && !current.builtinFallback) {
        throw new WorkflowDefinitionStoreError(409, "Deploy a valid draft before enabling");
      }
      if (current.deployedVersion != null) {
        const deployed = await getWorkflowDefinitionVersion(
          db,
          current.id,
          current.deployedVersion,
        );
        if (!deployed) {
          throw new WorkflowDefinitionStoreError(409, "The deployed version is unavailable");
        }
        assertValidDefinition(deployed.definition);
        triggerTypes = triggerTypesOf(deployed.definition);
      } else {
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
            AND builtin_fallback = ${current.builtinFallback}
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

export function serializeWorkflowDefinitionDeployment(
  row: WorkflowDefinitionDeploymentRow,
): WorkflowDefinitionDeployment {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
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
