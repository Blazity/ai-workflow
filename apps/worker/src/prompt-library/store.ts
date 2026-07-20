import { and, arrayContains, asc, desc, eq, inArray, isNull, max, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import type {
  PromptLibraryEntryMeta,
  PromptLibraryUsageRow,
  PromptLibraryVersion,
  WorkflowBlockType,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  promptLibrary,
  promptLibraryVersions,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { canEditPromptLibrary, type DashboardRole } from "../lib/auth/roles.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";

const VERSION_LIST_LIMIT = 50;
const QUERY_MAX_LENGTH = 100;

export interface PromptLibraryActor {
  role: DashboardRole;
  id: string;
  label: string;
}

export interface PromptLibraryRow {
  id: number;
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
}

/** Domain-level failure a write raises (400 invalid, 409 conflict, 404 not
 *  found). Routes map statusCode onto the HTTP response; distinct from the 403
 *  auth gate. */
export class PromptLibraryStoreError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type PromptSelect = typeof promptLibrary.$inferSelect;
type PromptVersionSelect = typeof promptLibraryVersions.$inferSelect;

function mapPromptRow(row: PromptSelect): PromptLibraryRow {
  return {
    id: row.id,
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
    createdAt: row.createdAt,
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
}

function requireEditRole(role: DashboardRole): void {
  if (!canEditPromptLibrary(role)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
}

// --- Input validation (write paths only). Length/count limits live here; the
// routes only do the cheap typeof checks. ---

function validateName(name: string): string {
  const parsed = z.string().trim().min(1).max(120).safeParse(name);
  if (!parsed.success) throw new PromptLibraryStoreError(400, "Invalid name");
  return parsed.data;
}

function validateDescription(description: string | null): string | null {
  if (description === null) return null;
  const parsed = z.string().trim().max(2000).safeParse(description);
  if (!parsed.success) throw new PromptLibraryStoreError(400, "Invalid description");
  return parsed.data.length > 0 ? parsed.data : null;
}

function validateTags(tags: string[]): string[] {
  const parsed = z.array(z.string().trim().min(1).max(40)).safeParse(tags);
  if (!parsed.success) throw new PromptLibraryStoreError(400, "Invalid tags");
  // De-duplicate (first occurrence wins) and bound the count on the deduped set,
  // so repeated tags collapse instead of eating into the 15-tag limit.
  const deduped = [...new Set(parsed.data)];
  if (deduped.length > 15) throw new PromptLibraryStoreError(400, "Invalid tags");
  return deduped;
}

function validateBody(body: string): string {
  const parsed = z.string().min(1).max(50000).safeParse(body);
  if (!parsed.success) throw new PromptLibraryStoreError(400, "Invalid body");
  return parsed.data;
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

/** Retries an operation on a unique-violation. Used for the version-number
 *  insert, the one race left now that writes run per-statement (neon-http has
 *  no interactive transactions). The (prompt_id, version) PK rejects the dup.
 *  Exported so the exhaustion mapping can be unit-tested directly, since a real
 *  cross-connection race is not forceable on single-connection PGlite. */
export async function retryOnUniqueViolation<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < attempts && isUniqueViolation(error)) continue;
      // Attempts exhausted. If we are still colliding on a unique index, a
      // concurrent writer kept taking our target slot; surface a truthful 409
      // instead of leaking the raw driver error as a 500. Non-unique errors
      // pass through unchanged.
      if (isUniqueViolation(error)) {
        throw new PromptLibraryStoreError(409, "Concurrent update, please retry");
      }
      throw error;
    }
  }
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

/** Case-insensitive substring token: trimmed, capped, lower-cased. `%` and `_`
 *  are matched literally because the filter runs in JS, not as a SQL LIKE. */
function normalizeQuery(q: string | undefined): string | null {
  if (!q) return null;
  const trimmed = q.trim().slice(0, QUERY_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function matchesQuery(row: PromptLibraryListRow, q: string): boolean {
  const haystack = [row.name, row.description ?? "", ...row.tags, row.body].join("\n").toLowerCase();
  return haystack.includes(q);
}

export async function listPrompts(
  db: Db,
  filter?: { q?: string; tag?: string; includeArchived?: boolean },
): Promise<PromptLibraryListRow[]> {
  const conditions = [];
  if (!filter?.includeArchived) conditions.push(isNull(promptLibrary.archivedAt));
  if (filter?.tag) conditions.push(arrayContains(promptLibrary.tags, [filter.tag]));
  const prompts = await db
    .select()
    .from(promptLibrary)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(promptLibrary.id))
    // Protective upper bound for the org-curated library (admin-controlled growth).
    .limit(500);
  if (prompts.length === 0) return [];

  // One grouped max(version) per prompt (no bodies), then fetch only the
  // (promptId, maxVersion) head rows' bodies. Avoids pulling every historical
  // version body (up to 50k each) just to reduce to the head in JS; same shape
  // as findPromptUsage's head lookup.
  const maxRows = await db
    .select({
      promptId: promptLibraryVersions.promptId,
      maxVersion: max(promptLibraryVersions.version),
    })
    .from(promptLibraryVersions)
    .where(
      inArray(
        promptLibraryVersions.promptId,
        prompts.map((p) => p.id),
      ),
    )
    .groupBy(promptLibraryVersions.promptId);

  const headByPrompt = new Map<number, { version: number; body: string }>();
  if (maxRows.length > 0) {
    const headRows = await db
      .select({
        promptId: promptLibraryVersions.promptId,
        version: promptLibraryVersions.version,
        body: promptLibraryVersions.body,
      })
      .from(promptLibraryVersions)
      .where(
        or(
          ...maxRows.map((m) =>
            and(
              eq(promptLibraryVersions.promptId, m.promptId),
              eq(promptLibraryVersions.version, m.maxVersion!),
            ),
          ),
        ),
      );
    for (const row of headRows) {
      headByPrompt.set(row.promptId, { version: row.version, body: row.body });
    }
  }

  // Skip any prompt with no head version: a list row requires body +
  // currentVersion, and a prompt with zero versions is an orphan (create's
  // parent insert landed but the version insert and its compensating delete
  // both failed). Mirrors listWorkflowDefinitions' degrade, but here dropping
  // the row is correct rather than nulling the version.
  const rows: PromptLibraryListRow[] = [];
  for (const p of prompts) {
    const head = headByPrompt.get(p.id);
    if (!head) continue;
    rows.push({ ...mapPromptRow(p), currentVersion: head.version, body: head.body });
  }

  const q = normalizeQuery(filter?.q);
  return q ? rows.filter((row) => matchesQuery(row, q)) : rows;
}

/** Reads archived prompts too (the detail routes gate on archivedAt themselves). */
export async function getPrompt(db: Db, id: number): Promise<PromptLibraryRow | null> {
  const rows = await db.select().from(promptLibrary).where(eq(promptLibrary.id, id)).limit(1);
  return rows[0] ? mapPromptRow(rows[0]) : null;
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

async function insertPromptParent(
  db: Db,
  input: { name: string; description: string | null; tags: string[]; actor: PromptLibraryActor },
): Promise<PromptSelect> {
  const rows = await db
    .insert(promptLibrary)
    .values({
      name: input.name,
      description: input.description,
      tags: input.tags,
      createdById: input.actor.id,
      createdByLabel: input.actor.label,
    })
    .returning();
  return rows[0]!;
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
async function tryHealOrphanName(db: Db, name: string): Promise<boolean> {
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

export async function createPrompt(
  db: Db,
  input: {
    name: string;
    body: string;
    description?: string | null;
    tags?: string[];
    actor: PromptLibraryActor;
  },
): Promise<{ prompt: PromptLibraryRow; current: PromptLibraryVersionRow }> {
  requireEditRole(input.actor.role);
  const name = validateName(input.name);
  const body = validateBody(input.body);
  const description = validateDescription(input.description ?? null);
  const tags = validateTags(input.tags ?? []);

  let created: PromptSelect;
  try {
    created = await insertPromptParent(db, { name, description, tags, actor: input.actor });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // The active-name unique index rejected the insert. Heal a zero-version
    // orphan holding the name and retry the insert once (no transactions on
    // neon-http, so this is a best-effort sequence). A live prompt keeps the
    // 409, and a concurrent healer racing us re-triggers 23505 -> also 409.
    const healed = await tryHealOrphanName(db, name);
    if (!healed) {
      throw new PromptLibraryStoreError(409, "Name already in use");
    }
    try {
      created = await insertPromptParent(db, { name, description, tags, actor: input.actor });
    } catch (retryError) {
      if (isUniqueViolation(retryError)) {
        throw new PromptLibraryStoreError(409, "Name already in use");
      }
      throw retryError;
    }
  }

  let current: PromptLibraryVersionRow;
  try {
    const versions = await db
      .insert(promptLibraryVersions)
      .values({
        promptId: created.id,
        version: 1,
        body,
        createdById: input.actor.id,
        createdByLabel: input.actor.label,
        restoredFromVersion: null,
      })
      .returning();
    current = mapVersionRow(versions[0]!);
  } catch (error) {
    // No transaction on neon-http: if the seed version fails to insert, remove
    // the just-created prompt so we never leave one without its version.
    await db.delete(promptLibrary).where(eq(promptLibrary.id, created.id)).catch(() => {});
    throw error;
  }
  return { prompt: mapPromptRow(created), current };
}

export async function savePromptVersion(
  db: Db,
  input: {
    promptId: number;
    body: string;
    restoredFromVersion?: number;
    actor: PromptLibraryActor;
  },
): Promise<{ version: PromptLibraryVersionRow; changed: boolean }> {
  requireEditRole(input.actor.role);
  const body = validateBody(input.body);
  const promptRows = await db
    .select()
    .from(promptLibrary)
    .where(eq(promptLibrary.id, input.promptId))
    .limit(1);
  const promptRow = promptRows[0];
  if (!promptRow) {
    throw new PromptLibraryStoreError(404, "Unknown prompt");
  }
  if (promptRow.archivedAt) {
    throw new PromptLibraryStoreError(409, "Prompt is archived");
  }

  const head = await getCurrentPromptVersion(db, input.promptId);
  if (head && head.body === body) {
    return { version: head, changed: false };
  }

  // Compute-then-insert the next version, retrying if a concurrent save took the
  // same number (the (prompt_id, version) PK rejects the duplicate).
  const saved = await retryOnUniqueViolation(async () => {
    const [{ maxVersion }] = await db
      .select({ maxVersion: max(promptLibraryVersions.version) })
      .from(promptLibraryVersions)
      .where(eq(promptLibraryVersions.promptId, input.promptId));
    const next = (maxVersion ?? 0) + 1;
    const rows = await db
      .insert(promptLibraryVersions)
      .values({
        promptId: input.promptId,
        version: next,
        body,
        createdById: input.actor.id,
        createdByLabel: input.actor.label,
        restoredFromVersion: input.restoredFromVersion ?? null,
      })
      .returning();
    return rows[0]!;
  });

  await db
    .update(promptLibrary)
    .set({ updatedAt: new Date() })
    .where(eq(promptLibrary.id, input.promptId));
  return { version: mapVersionRow(saved), changed: true };
}

export async function updatePromptMeta(
  db: Db,
  input: {
    promptId: number;
    name?: string;
    description?: string | null;
    tags?: string[];
    actor: PromptLibraryActor;
  },
): Promise<PromptLibraryRow> {
  requireEditRole(input.actor.role);
  const rows = await db
    .select()
    .from(promptLibrary)
    .where(eq(promptLibrary.id, input.promptId))
    .limit(1);
  const current = rows[0];
  if (!current) {
    throw new PromptLibraryStoreError(404, "Unknown prompt");
  }
  if (current.archivedAt) {
    throw new PromptLibraryStoreError(409, "Prompt is archived");
  }

  const set: { name?: string; description?: string | null; tags?: string[]; updatedAt?: Date } = {};
  if (input.name !== undefined) set.name = validateName(input.name);
  if (input.description !== undefined) set.description = validateDescription(input.description);
  if (input.tags !== undefined) set.tags = validateTags(input.tags);
  if (Object.keys(set).length === 0) return mapPromptRow(current);

  set.updatedAt = new Date();
  let updated: PromptSelect;
  try {
    const res = await db
      .update(promptLibrary)
      .set(set)
      .where(eq(promptLibrary.id, input.promptId))
      .returning();
    updated = res[0]!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PromptLibraryStoreError(409, "Name already in use");
    }
    throw error;
  }
  return mapPromptRow(updated);
}

export async function archivePrompt(
  db: Db,
  input: { promptId: number; actor: PromptLibraryActor },
): Promise<PromptLibraryRow> {
  requireEditRole(input.actor.role);
  const rows = await db
    .select()
    .from(promptLibrary)
    .where(eq(promptLibrary.id, input.promptId))
    .limit(1);
  const current = rows[0];
  if (!current) {
    throw new PromptLibraryStoreError(404, "Unknown prompt");
  }
  if (current.archivedAt) return mapPromptRow(current);

  const res = await db
    .update(promptLibrary)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(promptLibrary.id, input.promptId))
    .returning();
  return mapPromptRow(res[0]!);
}

export async function restorePromptVersion(
  db: Db,
  input: { promptId: number; version: number; actor: PromptLibraryActor },
): Promise<PromptLibraryVersionRow> {
  requireEditRole(input.actor.role);
  const sourceRows = await db
    .select()
    .from(promptLibraryVersions)
    .where(
      and(
        eq(promptLibraryVersions.promptId, input.promptId),
        eq(promptLibraryVersions.version, input.version),
      ),
    )
    .limit(1);
  const source = sourceRows[0];
  if (!source) {
    throw new PromptLibraryStoreError(404, "Unknown version");
  }

  const promptRows = await db
    .select()
    .from(promptLibrary)
    .where(eq(promptLibrary.id, input.promptId))
    .limit(1);
  const promptRow = promptRows[0];
  if (promptRow?.archivedAt) {
    throw new PromptLibraryStoreError(409, "Prompt is archived");
  }

  // Restore ALWAYS appends a new head, even when the source body equals the
  // current head (unlike savePromptVersion's no-op): the restore itself is the
  // recorded event, marked via restoredFromVersion.
  const saved = await retryOnUniqueViolation(async () => {
    const [{ maxVersion }] = await db
      .select({ maxVersion: max(promptLibraryVersions.version) })
      .from(promptLibraryVersions)
      .where(eq(promptLibraryVersions.promptId, input.promptId));
    const next = (maxVersion ?? 0) + 1;
    const rows = await db
      .insert(promptLibraryVersions)
      .values({
        promptId: input.promptId,
        version: next,
        body: source.body,
        createdById: input.actor.id,
        createdByLabel: input.actor.label,
        restoredFromVersion: source.version,
      })
      .returning();
    return rows[0]!;
  });

  await db
    .update(promptLibrary)
    .set({ updatedAt: new Date() })
    .where(eq(promptLibrary.id, input.promptId));
  return mapVersionRow(saved);
}

/** Walks the head version of every active workflow definition for block params
 *  that carry a promptRef to `promptId`, reporting each with its sync state
 *  against the library: "modified" when the stored param text no longer matches
 *  the referenced version body (or that version is gone), "behind" when the
 *  reference points at an older-than-head library version, else "current". */
export async function findPromptUsage(
  db: Db,
  promptId: number,
): Promise<PromptLibraryUsageRow[]> {
  const head = await getCurrentPromptVersion(db, promptId);
  const currentHeadVersion = head?.version ?? 0;

  const defs = await db
    .select({ id: workflowDefinitions.id, name: workflowDefinitions.name })
    .from(workflowDefinitions)
    .where(isNull(workflowDefinitions.archivedAt))
    .orderBy(asc(workflowDefinitions.id));
  if (defs.length === 0) return [];
  const defIds = defs.map((d) => d.id);

  const maxRows = await db
    .select({
      definitionId: workflowDefinitionVersions.definitionId,
      maxVersion: max(workflowDefinitionVersions.version),
    })
    .from(workflowDefinitionVersions)
    .where(inArray(workflowDefinitionVersions.definitionId, defIds))
    .groupBy(workflowDefinitionVersions.definitionId);
  if (maxRows.length === 0) return [];

  const headRows = await db
    .select({
      definitionId: workflowDefinitionVersions.definitionId,
      definition: workflowDefinitionVersions.definition,
    })
    .from(workflowDefinitionVersions)
    .where(
      or(
        ...maxRows.map((m) =>
          and(
            eq(workflowDefinitionVersions.definitionId, m.definitionId),
            eq(workflowDefinitionVersions.version, m.maxVersion!),
          ),
        ),
      ),
    );
  const headByDef = new Map(headRows.map((r) => [r.definitionId, r.definition]));

  // Each referenced library version's body is fetched at most once.
  const versionBodyCache = new Map<number, string | null>();
  async function bodyOfVersion(version: number): Promise<string | null> {
    const cached = versionBodyCache.get(version);
    if (cached !== undefined) return cached;
    const rows = await db
      .select({ body: promptLibraryVersions.body })
      .from(promptLibraryVersions)
      .where(
        and(eq(promptLibraryVersions.promptId, promptId), eq(promptLibraryVersions.version, version)),
      )
      .limit(1);
    const body = rows[0]?.body ?? null;
    versionBodyCache.set(version, body);
    return body;
  }

  const result: PromptLibraryUsageRow[] = [];
  for (const def of defs) {
    const definition = headByDef.get(def.id);
    if (!definition) continue;
    for (const node of definition.nodes) {
      if (!node.promptRefs) continue;
      for (const [paramKey, ref] of Object.entries(node.promptRefs)) {
        if (ref.promptId !== promptId) continue;
        const paramValue = node.params[paramKey];
        const text = typeof paramValue === "string" ? paramValue : null;
        const versionBody = await bodyOfVersion(ref.version);

        let state: "current" | "behind" | "modified";
        if (versionBody === null || text !== versionBody) {
          state = "modified";
        } else if (ref.version < currentHeadVersion) {
          state = "behind";
        } else {
          state = "current";
        }

        result.push({
          definitionId: def.id,
          definitionName: def.name,
          nodeId: node.id,
          nodeName: node.name ?? null,
          blockType: node.type as WorkflowBlockType,
          paramKey,
          version: ref.version,
          state,
        });
      }
    }
  }
  return result;
}

// --- Serialization ---

export function serializePromptMeta(
  row: PromptLibraryRow,
  currentVersion: number,
): PromptLibraryEntryMeta {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags: row.tags,
    currentVersion,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdByLabel: row.createdByLabel,
  };
}

export function serializePromptVersion(row: PromptLibraryVersionRow): PromptLibraryVersion {
  return {
    promptId: row.promptId,
    version: row.version,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
}
