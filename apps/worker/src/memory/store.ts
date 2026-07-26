import { and, asc, desc, eq } from "drizzle-orm";
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
): Promise<void> {
  // TextEncoder, not Buffer: this module is reachable from workflow scope,
  // which forbids Node builtins at module scope.
  const bytes = new TextEncoder().encode(input.content).byteLength;
  if (bytes > MAX_MEMORY_DOCUMENT_BYTES) {
    throw new Error(
      `${input.subjectKey} ${input.docPath} exceeds the memory document size limit (${bytes} > ${MAX_MEMORY_DOCUMENT_BYTES})`,
    );
  }
  await db
    .insert(agentMemoryDocuments)
    .values({
      subjectKey: input.subjectKey,
      docPath: input.docPath,
      ticketKey: input.ticketKey,
      content: input.content,
      bytes,
      sourceRunId: input.sourceRunId,
    })
    .onConflictDoUpdate({
      target: [agentMemoryDocuments.subjectKey, agentMemoryDocuments.docPath],
      set: {
        content: input.content,
        ticketKey: input.ticketKey,
        bytes,
        sourceRunId: input.sourceRunId,
        updatedAt: new Date(),
      },
    });
}
