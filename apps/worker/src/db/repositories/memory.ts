import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { agentMemoryDocuments } from "../schema.js";

export const MAX_MEMORY_DOCUMENT_BYTES = 256 * 1024;

/**
 * Stamped on the size refusal below, and read by a catch that is nowhere near
 * this module.
 *
 * A property rather than an exported class on purpose: the only reader is a
 * `catch` inside a `"use step"`, where every import is deferred, and a catch
 * that has to `await import` a module in order to name the error it just
 * caught can fail cold on exactly the path that is already going wrong.
 *
 * It exists because the two failures a caller can get out of a write mean
 * opposite things. A database that could not be reached is worth retrying; a
 * document that is bigger than this store will ever accept is not, and
 * reporting the second as the first sends a caller back to spend a model call
 * on an answer that will be refused again.
 */
export const MEMORY_DOCUMENT_TOO_LARGE = "memory_document_too_large";
/** The cap a listing runs under when the caller names none, which is every
 *  caller today: neither the memory screen nor the `memory.list` tool passes a
 *  limit. Exported so a test can name the same number the query uses rather
 *  than hard-coding a copy that drifts. */
export const DEFAULT_MEMORY_LIST_LIMIT = 100;
const MAX_MEMORY_LIST_LIMIT = 200;

export interface MemoryDocument {
  content: string;
  bytes: number;
  updatedAt: Date;
  sourceRunId: string;
  version: number;
}

/**
 * A listed document without its body, so a listing never ships the content.
 *
 * Local since S13: the built-in provider is the only caller, and it answers in
 * the SDK's own `MemoryStoredSummary`, so nothing outside this file names it.
 */
interface MemoryDocumentSummary {
  subjectKey: string;
  docPath: string;
  ticketKey: string | null;
  bytes: number;
  sourceRunId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListMemoryDocumentsOptions {
  ticketKey?: string;
  limit?: number;
}

/**
 * A page of the listing, and whether it is the whole of it.
 *
 * `complete` is answered HERE because the cap is decided here. A caller that
 * gets bare rows cannot tell a store holding exactly this many documents from
 * one whose listing the cap cut short, and answering "this is everything" for
 * the second is how somebody reports an erasure done on a document that is
 * still stored.
 */
export interface MemoryDocumentListing {
  documents: MemoryDocumentSummary[];
  complete: boolean;
}

export interface UpsertMemoryDocumentInput {
  subjectKey: string;
  docPath: string;
  ticketKey: string | null;
  content: string;
  sourceRunId: string;
  /**
   * Version the caller based its content on, for read-modify-write callers
   * that would otherwise silently drop a concurrent writer's items. 0 means
   * "I read no row, I am the creator", so the required idiom is
   * `expectedVersion: stored?.version ?? 0`. Omit the key entirely for
   * last-writer-wins; passing it as `undefined` throws.
   */
  expectedVersion?: number;
}

/** `applied: false` means another writer got there first; nothing was written. */
export interface UpsertMemoryDocumentResult {
  applied: boolean;
  version: number | null;
}

export async function getMemoryDocument(
  db: Db,
  subjectKey: string,
  docPath: string,
): Promise<MemoryDocument | null> {
  const [row] = await db
    .select({
      content: agentMemoryDocuments.content,
      bytes: agentMemoryDocuments.bytes,
      updatedAt: agentMemoryDocuments.updatedAt,
      sourceRunId: agentMemoryDocuments.sourceRunId,
      version: agentMemoryDocuments.version,
    })
    .from(agentMemoryDocuments)
    .where(
      and(
        eq(agentMemoryDocuments.subjectKey, subjectKey),
        eq(agentMemoryDocuments.docPath, docPath),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listMemoryDocuments(
  db: Db,
  options: ListMemoryDocumentsOptions = {},
): Promise<MemoryDocumentListing> {
  const requested = options.limit;
  const limit =
    requested !== undefined && Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_MEMORY_LIST_LIMIT)
      : DEFAULT_MEMORY_LIST_LIMIT;
  // One row past the cap, asked for and never returned. It is the only thing
  // that separates a store holding exactly `limit` documents from one the cap
  // cut short, and the probe is applied AFTER the clamp above so it still works
  // at MAX_MEMORY_LIST_LIMIT, where clamping the probe itself would make the
  // largest listing the one that can never admit it is partial.
  const rows = await db
    .select({
      subjectKey: agentMemoryDocuments.subjectKey,
      docPath: agentMemoryDocuments.docPath,
      ticketKey: agentMemoryDocuments.ticketKey,
      bytes: agentMemoryDocuments.bytes,
      sourceRunId: agentMemoryDocuments.sourceRunId,
      createdAt: agentMemoryDocuments.createdAt,
      updatedAt: agentMemoryDocuments.updatedAt,
    })
    .from(agentMemoryDocuments)
    .where(
      options.ticketKey === undefined
        ? undefined
        : eq(agentMemoryDocuments.ticketKey, options.ticketKey),
    )
    // Primary key as the tie-break, so documents written inside one timestamp
    // still come back in a stable order.
    .orderBy(
      desc(agentMemoryDocuments.updatedAt),
      asc(agentMemoryDocuments.subjectKey),
      asc(agentMemoryDocuments.docPath),
    )
    .limit(limit + 1);
  return rows.length > limit
    ? { documents: rows.slice(0, limit), complete: false }
    : { documents: rows, complete: true };
}

/**
 * Hard delete of one document, keyed by the primary key. `false` means no row
 * matched, so a caller can answer "not found" instead of claiming a removal it
 * never made. A soft delete is deliberately not offered: this path exists to
 * answer erasure and leak-remediation requests, and a flagged row would leave
 * the remembered text in the table. Single statement, because neon-http has no
 * transactions.
 */
export async function deleteMemoryDocument(
  db: Db,
  subjectKey: string,
  docPath: string,
): Promise<boolean> {
  const removed = await db
    .delete(agentMemoryDocuments)
    .where(
      and(
        eq(agentMemoryDocuments.subjectKey, subjectKey),
        eq(agentMemoryDocuments.docPath, docPath),
      ),
    )
    .returning({ docPath: agentMemoryDocuments.docPath });
  return removed.length > 0;
}

export async function upsertMemoryDocument(
  db: Db,
  input: UpsertMemoryDocumentInput,
): Promise<UpsertMemoryDocumentResult> {
  // The key present with an undefined value is a caller bug, not a request for
  // the blind path. Without exactOptionalPropertyTypes `stored?.version` type
  // checks here, and it is undefined exactly when no row exists yet, which is
  // the case a read-modify-write caller most needs to lose.
  if ("expectedVersion" in input && input.expectedVersion === undefined) {
    throw new Error(
      `${input.subjectKey} ${input.docPath} got expectedVersion: undefined; pass \`stored?.version ?? 0\`, or omit the key for a blind write`,
    );
  }
  // TextEncoder, not Buffer: this module is reachable from workflow scope,
  // which forbids Node builtins at module scope.
  const bytes = new TextEncoder().encode(input.content).byteLength;
  if (bytes > MAX_MEMORY_DOCUMENT_BYTES) {
    throw Object.assign(
      new Error(
        `${input.subjectKey} ${input.docPath} exceeds the memory document size limit (${bytes} > ${MAX_MEMORY_DOCUMENT_BYTES})`,
      ),
      { code: MEMORY_DOCUMENT_TOO_LARGE },
    );
  }
  const values = {
    subjectKey: input.subjectKey,
    docPath: input.docPath,
    ticketKey: input.ticketKey,
    content: input.content,
    bytes,
    sourceRunId: input.sourceRunId,
  };

  if (input.expectedVersion === 0) {
    // The caller read no row, so it may only create one. Losing the race means
    // its content was distilled from a state that no longer exists.
    const [created] = await db
      .insert(agentMemoryDocuments)
      .values(values)
      .onConflictDoNothing({
        target: [agentMemoryDocuments.subjectKey, agentMemoryDocuments.docPath],
      })
      .returning({ version: agentMemoryDocuments.version });
    return created
      ? { applied: true, version: created.version }
      : { applied: false, version: null };
  }

  const set = {
    content: input.content,
    ticketKey: input.ticketKey,
    bytes,
    sourceRunId: input.sourceRunId,
    updatedAt: new Date(),
    version: sql`${agentMemoryDocuments.version} + 1`,
  };

  if (input.expectedVersion !== undefined) {
    // Compare and swap in one statement: neon-http has no transactions, so the
    // version predicate is what makes the read-modify-write safe.
    const [swapped] = await db
      .update(agentMemoryDocuments)
      .set(set)
      .where(
        and(
          eq(agentMemoryDocuments.subjectKey, input.subjectKey),
          eq(agentMemoryDocuments.docPath, input.docPath),
          eq(agentMemoryDocuments.version, input.expectedVersion),
        ),
      )
      .returning({ version: agentMemoryDocuments.version });
    return swapped
      ? { applied: true, version: swapped.version }
      : { applied: false, version: null };
  }

  const [written] = await db
    .insert(agentMemoryDocuments)
    .values(values)
    .onConflictDoUpdate({
      target: [agentMemoryDocuments.subjectKey, agentMemoryDocuments.docPath],
      set,
    })
    .returning({ version: agentMemoryDocuments.version });
  return { applied: true, version: written?.version ?? null };
}

export function getConnectedMemoryDocument(subjectKey: string, docPath: string) {
  return getMemoryDocument(getDb(), subjectKey, docPath);
}

export function listConnectedMemoryDocuments(options: ListMemoryDocumentsOptions = {}) {
  return listMemoryDocuments(getDb(), options);
}

export function deleteConnectedMemoryDocument(subjectKey: string, docPath: string) {
  return deleteMemoryDocument(getDb(), subjectKey, docPath);
}

export function upsertConnectedMemoryDocument(input: UpsertMemoryDocumentInput) {
  return upsertMemoryDocument(getDb(), input);
}
