import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentMemoryDocuments } from "../db/schema.js";

export const MAX_MEMORY_DOCUMENT_BYTES = 256 * 1024;

export interface MemoryDocument {
  content: string;
  bytes: number;
  updatedAt: Date;
  sourceRunId: string;
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
