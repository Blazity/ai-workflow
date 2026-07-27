import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentMemoryDocuments } from "../db/schema.js";

export const MAX_MEMORY_DOCUMENT_BYTES = 256 * 1024;
export const DEFAULT_MEMORY_LIST_LIMIT = 100;
export const MAX_MEMORY_LIST_LIMIT = 200;

export interface MemoryDocument {
  content: string;
  bytes: number;
  updatedAt: Date;
  sourceRunId: string;
  version: number;
}

/** A listed document without its body, so a listing never ships the content. */
export interface MemoryDocumentSummary {
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
): Promise<MemoryDocumentSummary[]> {
  const requested = options.limit;
  const limit =
    requested !== undefined && Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_MEMORY_LIST_LIMIT)
      : DEFAULT_MEMORY_LIST_LIMIT;
  return db
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
    .limit(limit);
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
    throw new Error(
      `${input.subjectKey} ${input.docPath} exceeds the memory document size limit (${bytes} > ${MAX_MEMORY_DOCUMENT_BYTES})`,
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
