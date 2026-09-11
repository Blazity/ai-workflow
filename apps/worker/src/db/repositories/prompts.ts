import { and, arrayContains, asc, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type {
  PromptSlotDefinition,
} from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import {
  promptLibrary,
  promptLibraryVersions,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../schema.js";

const VERSION_LIST_LIMIT = 50;

export interface PromptLibraryActor {
  /** Authorization is decided by the prompt service before persistence. */
  role?: string;
  id: string;
  label: string;
}

export interface PromptLibraryRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  tags: string[];
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
  createdByLabel: string;
}

export interface PromptLibraryVersionRow {
  promptId: number;
  version: number;
  body: string;
  slots: PromptSlotDefinition[];
  createdAt: Date;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
}

/** List row = parent meta + head version number + head body, so the list view
 *  needs no per-prompt version fetch for its insert picker and drift check. */
export interface PromptLibraryListRow extends PromptLibraryRow {
  currentVersion: number;
  body: string;
  slots: PromptSlotDefinition[];
}

type PromptSelect = typeof promptLibrary.$inferSelect;
type PromptVersionSelect = typeof promptLibraryVersions.$inferSelect;

function mapPromptRow(row: PromptSelect): PromptLibraryRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags: row.tags,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
  };
}

function mapVersionRow(row: PromptVersionSelect): PromptLibraryVersionRow {
  return {
    promptId: row.promptId,
    version: row.version,
    body: row.body,
    slots: structuredClone(row.slots),
    createdAt: row.createdAt,
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

// --- Reads (no role gate) ---

export async function findPromptRowsByNames(
  db: Db,
  names: readonly string[],
): Promise<PromptLibraryRow[]> {
  if (names.length === 0) return [];
  const rows = await db
    .select()
    .from(promptLibrary)
    .where(inArray(promptLibrary.name, [...names]))
    .orderBy(asc(promptLibrary.id));
  return rows.map(mapPromptRow);
}

export async function listPromptHeadRows(
  db: Db,
  filter?: { tag?: string; includeArchived?: boolean },
): Promise<PromptLibraryListRow[]> {
  const conditions = [];
  if (!filter?.includeArchived) conditions.push(isNull(promptLibrary.archivedAt));
  if (filter?.tag) conditions.push(arrayContains(promptLibrary.tags, [filter.tag]));
  const rows = await db
    .selectDistinctOn([promptLibrary.id], {
      prompt: promptLibrary,
      currentVersion: promptLibraryVersions.version,
      body: promptLibraryVersions.body,
      slots: promptLibraryVersions.slots,
    })
    .from(promptLibrary)
    .innerJoin(promptLibraryVersions, eq(promptLibraryVersions.promptId, promptLibrary.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(promptLibrary.id), desc(promptLibraryVersions.version))
    .limit(500);
  return rows.map((row) => Object.assign({}, mapPromptRow(row.prompt), {
    currentVersion: row.currentVersion,
    body: row.body,
    slots: structuredClone(row.slots),
  }));
}

/** Reads archived prompts too (the detail routes gate on archivedAt themselves). */
export async function getPrompt(db: Db, id: number): Promise<PromptLibraryRow | null> {
  const rows = await db.select().from(promptLibrary).where(eq(promptLibrary.id, id)).limit(1);
  return rows[0] ? mapPromptRow(rows[0]) : null;
}

/** Resolves a {{prompt:<slug>}} target. Slugs are unique among active prompts;
 *  when only archived rows hold the slug, the newest one is returned so pinned
 *  references to archived prompts keep resolving. */
export async function findPromptBySlug(db: Db, slug: string): Promise<PromptLibraryRow | null> {
  const rows = await db
    .select()
    .from(promptLibrary)
    .where(eq(promptLibrary.slug, slug))
    .orderBy(desc(promptLibrary.id));
  if (rows.length === 0) return null;
  const active = rows.find((row) => row.archivedAt === null);
  return mapPromptRow(active ?? rows[0]!);
}

export async function getCurrentPromptVersion(
  db: Db,
  promptId: number,
): Promise<PromptLibraryVersionRow | null> {
  const rows = await db
    .select()
    .from(promptLibraryVersions)
    .where(eq(promptLibraryVersions.promptId, promptId))
    .orderBy(desc(promptLibraryVersions.version))
    .limit(1);
  return rows[0] ? mapVersionRow(rows[0]) : null;
}

/** Reads a version regardless of the parent prompt's archived state. */
export async function getPromptVersion(
  db: Db,
  promptId: number,
  version: number,
): Promise<PromptLibraryVersionRow | null> {
  const rows = await db
    .select()
    .from(promptLibraryVersions)
    .where(and(eq(promptLibraryVersions.promptId, promptId), eq(promptLibraryVersions.version, version)))
    .limit(1);
  return rows[0] ? mapVersionRow(rows[0]) : null;
}

export async function listPromptVersionRows(
  db: Db,
  promptId: number,
): Promise<PromptLibraryVersionRow[]> {
  const rows = await db
    .select()
    .from(promptLibraryVersions)
    .where(eq(promptLibraryVersions.promptId, promptId))
    .orderBy(desc(promptLibraryVersions.version))
    .limit(VERSION_LIST_LIMIT);
  return rows.map(mapVersionRow);
}

// --- Writes (role-gated). Each write is a single statement or a
// retry-guarded sequence; the (prompt_id, version) PK and the active-name
// partial unique index (not a lock) provide the real guarantees. ---

export async function createPromptWithInitialVersion(
  db: Db,
  input: {
    name: string;
    slug: string;
    body: string;
    slots: PromptSlotDefinition[];
    description: string | null;
    tags: string[];
    actor: PromptLibraryActor;
  },
): Promise<{ prompt: PromptLibraryRow; current: PromptLibraryVersionRow }> {
  const result = await db.execute(sql`
    WITH created AS (
      INSERT INTO prompt_library
        (name, slug, description, tags, created_by_id, created_by_label)
      VALUES (
        ${input.name}, ${input.slug}, ${input.description},
        ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.tags)}::jsonb)),
        ${input.actor.id}, ${input.actor.label}
      )
      RETURNING *
    ), seeded AS (
      INSERT INTO prompt_library_versions
        (prompt_id, version, body, slots, created_by_id, created_by_label, restored_from_version)
      SELECT id, 1, ${input.body}, ${JSON.stringify(input.slots)}::jsonb,
        ${input.actor.id}, ${input.actor.label}, NULL
      FROM created
      RETURNING *
    )
    SELECT
      created.id, created.slug, created.name, created.description, created.tags,
      created.archived_at, created.created_at, created.updated_at,
      created.created_by_id, created.created_by_label,
      seeded.version, seeded.body, seeded.slots,
      seeded.created_at AS version_created_at,
      seeded.created_by_id AS version_created_by_id,
      seeded.created_by_label AS version_created_by_label,
      seeded.restored_from_version
    FROM created
    JOIN seeded ON seeded.prompt_id = created.id
  `);
  const row = rawRows<{
    id: number; slug: string; name: string; description: string | null; tags: string[];
    archived_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
    created_by_id: string; created_by_label: string; version: number; body: string;
    slots: PromptSlotDefinition[]; version_created_at: Date | string;
    version_created_by_id: string; version_created_by_label: string;
    restored_from_version: number | null;
  }>(result)[0];
  if (!row) throw new Error("prompt insert did not return a row");
  return {
    prompt: {
      id: row.id, slug: row.slug, name: row.name, description: row.description,
      tags: row.tags,
      archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at), createdById: row.created_by_id,
      createdByLabel: row.created_by_label,
    },
    current: {
      promptId: row.id, version: row.version, body: row.body,
      slots: structuredClone(row.slots), createdAt: new Date(row.version_created_at),
      createdById: row.version_created_by_id,
      createdByLabel: row.version_created_by_label,
      restoredFromVersion: row.restored_from_version,
    },
  };
}

/** Heal path for createPrompt's active-name conflict: if the row holding the
 *  name is a zero-version orphan (a parent left behind when an earlier create's
 *  version-1 seed and its compensating delete both failed), delete it so the
 *  caller can retry the insert. Deleting a zero-version row is safe because
 *  nothing references it. Returns true when an orphan was removed; a live prompt
 *  (>= 1 version) is left untouched so the caller keeps the 409.
 *
 *  The delete is a single conditional statement (NOT EXISTS guard) rather than a
 *  read-then-delete, so a row that gains a version between a check and the delete
 *  can never be removed: the guard is evaluated atomically with the delete.
 *  Equivalent to:
 *    DELETE FROM prompt_library
 *    WHERE name = $name AND archived_at IS NULL
 *      AND NOT EXISTS (
 *        SELECT 1 FROM prompt_library_versions WHERE prompt_id = prompt_library.id
 *      ) */
export async function deleteOrphanPromptByName(db: Db, name: string): Promise<boolean> {
  const deleted = await db
    .delete(promptLibrary)
    .where(
      and(
        eq(promptLibrary.name, name),
        isNull(promptLibrary.archivedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(promptLibraryVersions)
            .where(eq(promptLibraryVersions.promptId, promptLibrary.id)),
        ),
      ),
    )
    .returning({ id: promptLibrary.id });
  return deleted.length > 0;
}

/** Picks the first slug candidate not held by an active prompt: the base, then
 *  base-2, base-3, ... The active-slug unique index still backstops races. */
export async function listActivePromptSlugsByPrefix(db: Db, base: string): Promise<string[]> {
  const rows = await db
    .select({ slug: promptLibrary.slug })
    .from(promptLibrary)
    .where(and(isNull(promptLibrary.archivedAt), sql`${promptLibrary.slug} like ${`${base}%`}`));
  return rows.map((row) => row.slug);
}

export async function updatePromptMeta(db: Db, input: { promptId: number; name?: string; description?: string | null; tags?: string[]; actor: PromptLibraryActor }): Promise<PromptLibraryRow | null> {
  const set: { name?: string; description?: string | null; tags?: string[]; updatedAt?: Date } = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  if (input.tags !== undefined) set.tags = input.tags;
  if (Object.keys(set).length === 0) return null;
  set.updatedAt = new Date();
  const rows = await db.update(promptLibrary).set(set).where(and(eq(promptLibrary.id, input.promptId), isNull(promptLibrary.archivedAt))).returning();
  return rows[0] ? mapPromptRow(rows[0]) : null;
}

export async function archivePrompt(db: Db, input: { promptId: number; actor: PromptLibraryActor }): Promise<PromptLibraryRow | null> {
  const rows = await db.update(promptLibrary).set({ archivedAt: new Date(), updatedAt: new Date() }).where(and(eq(promptLibrary.id, input.promptId), isNull(promptLibrary.archivedAt))).returning();
  return rows[0] ? mapPromptRow(rows[0]) : null;
}

/** One-statement append. The caller supplies already-authorized, canonical
 * input and decides whether an identical head is a no-op or a restore event. */
export async function appendPromptVersion(
  db: Db,
  input: {
    promptId: number; body: string; slots: PromptSlotDefinition[];
    restoredFromVersion: number | null; actor: PromptLibraryActor;
    expectedVersion?: number;
  },
): Promise<PromptLibraryVersionRow | null> {
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT p.id
      FROM prompt_library p
      WHERE p.id = ${input.promptId} AND p.archived_at IS NULL
        AND (${input.expectedVersion ?? null}::int IS NULL OR COALESCE((
          SELECT MAX(v.version) FROM prompt_library_versions v WHERE v.prompt_id = p.id
        ), 0) = ${input.expectedVersion ?? null}::int)
    ), inserted AS (
      INSERT INTO prompt_library_versions
        (prompt_id, version, body, slots, created_by_id, created_by_label, restored_from_version)
      SELECT c.id, COALESCE((SELECT MAX(v.version) FROM prompt_library_versions v WHERE v.prompt_id = c.id), 0) + 1,
        ${input.body}, ${JSON.stringify(input.slots)}::jsonb, ${input.actor.id}, ${input.actor.label}, ${input.restoredFromVersion}
      FROM candidate c
      RETURNING *
    ), touched AS (
      UPDATE prompt_library p SET updated_at = now() FROM inserted i WHERE p.id = i.prompt_id
    )
    SELECT * FROM inserted
  `);
  const row = rawRows<{
    prompt_id: number;
    version: number;
    body: string;
    slots: PromptSlotDefinition[];
    created_at: Date | string;
    created_by_id: string;
    created_by_label: string;
    restored_from_version: number | null;
  }>(result)[0];
  return row
    ? mapVersionRow({
        promptId: row.prompt_id,
        version: row.version,
        body: row.body,
        slots: row.slots,
        createdAt: new Date(row.created_at),
        createdById: row.created_by_id,
        createdByLabel: row.created_by_label,
        restoredFromVersion: row.restored_from_version,
      })
    : null;
}

export interface PromptUsageDefinitionHead {
  id: number;
  name: string;
  definition: unknown;
}

/** Raw definition heads for the prompt-usage service. Parsing stays above the
 * database tier while this pre-stage-7 store still owns the query. */
export async function listPromptUsageDefinitionHeads(
  db: Db,
): Promise<PromptUsageDefinitionHead[]> {
  return db
    .selectDistinctOn([workflowDefinitions.id], {
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      definition: workflowDefinitionVersions.definition,
    })
    .from(workflowDefinitions)
    .innerJoin(
      workflowDefinitionVersions,
      eq(workflowDefinitionVersions.definitionId, workflowDefinitions.id),
    )
    .where(isNull(workflowDefinitions.archivedAt))
    .orderBy(asc(workflowDefinitions.id), desc(workflowDefinitionVersions.version));
}

export function findConnectedPromptBySlug(slug: string) {
  return findPromptBySlug(getDb(), slug);
}

export function getConnectedPrompt(id: number) {
  return getPrompt(getDb(), id);
}

export function getConnectedCurrentPromptVersion(promptId: number) {
  return getCurrentPromptVersion(getDb(), promptId);
}

export function getConnectedPromptVersion(promptId: number, version: number) {
  return getPromptVersion(getDb(), promptId, version);
}

export function listConnectedPromptHeadRows(input: Parameters<typeof listPromptHeadRows>[1]) {
  return listPromptHeadRows(getDb(), input);
}

export function listConnectedPromptVersionRows(promptId: number) {
  return listPromptVersionRows(getDb(), promptId);
}

export function createConnectedPromptWithInitialVersion(input: Parameters<typeof createPromptWithInitialVersion>[1]) {
  return createPromptWithInitialVersion(getDb(), input);
}

export function deleteConnectedOrphanPromptByName(name: string) {
  return deleteOrphanPromptByName(getDb(), name);
}

export function listConnectedActivePromptSlugsByPrefix(base: string) {
  return listActivePromptSlugsByPrefix(getDb(), base);
}

export function updateConnectedPromptMeta(input: Parameters<typeof updatePromptMeta>[1]) {
  return updatePromptMeta(getDb(), input);
}

export function archiveConnectedPrompt(input: Parameters<typeof archivePrompt>[1]) {
  return archivePrompt(getDb(), input);
}


export function appendConnectedPromptVersion(input: Parameters<typeof appendPromptVersion>[1]) {
  return appendPromptVersion(getDb(), input);
}

export function listConnectedPromptUsageDefinitionHeads() {
  return listPromptUsageDefinitionHeads(getDb());
}
