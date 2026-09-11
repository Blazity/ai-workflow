/**
 * The agent's memory, as the dashboard reads and erases it.
 *
 * The store below takes a connection and answers about rows; this decides what
 * a dashboard request to read or erase memory means, including the two refusals
 * that are not about permission: a key pair that names nothing, and a key long
 * enough to be a malformed or hostile request rather than something the agent
 * ever wrote.
 */
import {
  deleteConnectedMemoryDocument,
  getConnectedMemoryDocument,
  listConnectedMemoryDocuments,
  type MemoryDocument,
  type MemoryDocumentSummary,
} from "../../db/repositories/memory.js";

/**
 * Subject keys and doc paths the agent writes are short identifiers, so a longer
 * value is a malformed or hostile request and is refused before it reaches the
 * database.
 */
export const MAX_MEMORY_KEY_LENGTH = 512;

/** Whether a client-supplied key part is one the agent could have written. */
export function isUsableMemoryKeyPart(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_MEMORY_KEY_LENGTH
  );
}

/** One document with its content, or null when that pair names nothing. */
export function readMemoryDocument(
  subjectKey: string,
  docPath: string,
): Promise<MemoryDocument | null> {
  return getConnectedMemoryDocument(subjectKey, docPath);
}

/** The listing, without content, optionally narrowed to one ticket. */
export function listMemoryDocumentSummaries(options: {
  ticketKey?: string;
}): Promise<MemoryDocumentSummary[]> {
  return listConnectedMemoryDocuments(options);
}

/**
 * Erase one document. False means nothing was there to erase, which the caller
 * answers as a miss rather than as a success: an erasure request that found
 * nothing has not been honoured, it has been answered about the wrong document.
 */
export function eraseMemoryDocument(
  subjectKey: string,
  docPath: string,
): Promise<boolean> {
  return deleteConnectedMemoryDocument(subjectKey, docPath);
}
