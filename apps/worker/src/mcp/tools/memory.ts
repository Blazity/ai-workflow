/**
 * What the agent remembered, as tools.
 *
 * Three, for the three things a person does with it on the memory screen: see
 * what is there, read one document, erase one. They are the MCP half of the
 * same HTTP routes, under the same rules, because every dashboard action on
 * this record has an equivalent here.
 *
 * The service cluster is the seam, never the route handler, so a tool cannot
 * reach past a rule the dashboard obeys. Since S13 that service resolves
 * whichever provider keeps this deployment's memory, which is why two refusals
 * here are not errors in the ordinary sense: a provider that cannot enumerate
 * what it holds is working correctly and simply cannot answer a listing, and
 * saying so is the whole point. An empty list would be a lie.
 *
 * Everything these tools return is text a run wrote: a model's distillation, or
 * the notebook an agent kept. It is untrusted content, labelled as such by the
 * envelope, and a client that reads it as instruction is reading a report as an
 * order.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  eraseMemoryDocument,
  isUsableMemoryKeyPart,
  listMemoryDocumentSummaries,
  readMemoryDocument,
} from "../../services/memory/index.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpMutation, executeMcpRead } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import { mcpEnvelopeResult, registerCatalogTool } from "../tool-catalog.js";

interface MemoryListData {
  documents: Array<{
    subjectKey: string;
    docPath: string;
    ticketKey: string | null;
    bytes: number;
    sourceRunId: string;
    createdAt: string;
    updatedAt: string;
  }>;
  /** False when the provider cannot promise this is everything it holds. */
  complete: boolean;
}

interface MemoryGetData {
  subjectKey: string;
  docPath: string;
  bytes: number;
  sourceRunId: string;
  updatedAt: string;
  content: string;
}

interface MemoryForgetData {
  subjectKey: string;
  docPath: string;
  forgotten: true;
}

/**
 * A provider that could not answer, as an error a client can act on.
 *
 * One code, two `retryable` answers, because those are the two different next
 * moves and the code list has no word for "this provider will never do that".
 * `retryable: true` is a provider that is away or a settings read that failed;
 * `retryable: false` is a provider that serves runs perfectly well and simply
 * has no enumerable store, where coming back later changes nothing. The
 * message says which, in the provider's own words.
 *
 * `effectNotApplied` is true on both: nothing was erased or read, so a client
 * holding an idempotency key may reuse it.
 */
function providerRefused(reason: string, listable: boolean): McpPublicError {
  return new McpPublicError("DEPENDENCY_UNAVAILABLE", reason, listable, undefined, true);
}

/** Refused before anything was erased, so the idempotency key is unspent. */
function refused(code: McpPublicError["code"], message: string): McpPublicError {
  return new McpPublicError(code, message, false, undefined, true);
}

/**
 * Key parts come from the client, so they are bounded here before they reach a
 * provider, exactly as the HTTP route bounds them. The schema already caps the
 * length; this rejects the rest and keeps the two surfaces on one rule.
 */
function requireKeyPart(value: string, field: string): string {
  if (!isUsableMemoryKeyPart(value)) {
    throw refused("VALIDATION_FAILED", `${field} is not a memory key the agent could have written`);
  }
  return value;
}

export function registerMemoryTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(server, "memory.list", async (input) => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "memory.list",
      targetRefs: input.ticketKey === undefined ? [] : [input.ticketKey],
      operation: async (): Promise<MemoryListData> => {
        const listing = await listMemoryDocumentSummaries(
          input.ticketKey === undefined ? {} : { ticketKey: input.ticketKey },
        );
        if (!listing.ok) throw providerRefused(listing.reason, listing.listable);
        return {
          documents: listing.documents.map((row) => ({
            subjectKey: row.subjectKey,
            docPath: row.docPath,
            ticketKey: row.ticketKey,
            bytes: row.bytes,
            sourceRunId: row.sourceRunId,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          })),
          // Carried through rather than dropped: an agent that reads a listing
          // as everything a subject knows, when the provider never promised
          // that, will conclude a fact was forgotten and re-derive it.
          complete: listing.complete,
        };
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "memory.get", async (input) => {
    const subjectKey = requireKeyPart(input.subjectKey, "subjectKey");
    const docPath = requireKeyPart(input.docPath, "docPath");
    const envelope = await executeMcpRead({
      deps,
      toolName: "memory.get",
      targetRefs: [subjectKey, docPath],
      operation: async (): Promise<MemoryGetData> => {
        const read = await readMemoryDocument(subjectKey, docPath);
        if (!read.ok) throw providerRefused(read.reason, read.listable);
        if (!read.document) {
          throw new McpPublicError(
            "NOT_FOUND",
            "No memory document is stored under that pair",
            false,
          );
        }
        return {
          subjectKey,
          docPath,
          bytes: read.document.bytes,
          sourceRunId: read.document.sourceRunId,
          updatedAt: read.document.updatedAt.toISOString(),
          content: read.document.content,
        };
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "memory.forget", async (input) => {
    const subjectKey = requireKeyPart(input.subjectKey, "subjectKey");
    const docPath = requireKeyPart(input.docPath, "docPath");
    const envelope = await executeMcpMutation({
      deps,
      toolName: "memory.forget",
      // Both halves of the address: each is a string an operator can search the
      // audit for, and an erasure has to be traceable to the document it took.
      targetRefs: [subjectKey, docPath],
      idempotencyKey: input.idempotencyKey,
      payloadHash: hashCanonicalJson(input),
      operation: async (): Promise<MemoryForgetData> => {
        const erasure = await eraseMemoryDocument(subjectKey, docPath);
        if (!erasure.ok) throw providerRefused(erasure.reason, erasure.listable);
        if (!erasure.erased) {
          // NOT_FOUND rather than a success, and the reasoning is the same as
          // the dashboard route's: an erasure request that found nothing has
          // not been honoured, it has been aimed at the wrong document, and
          // answering "done" is how somebody stops looking for their data.
          throw new McpPublicError(
            "NOT_FOUND",
            "No memory document is stored under that pair",
            false,
            undefined,
            true,
          );
        }
        return { subjectKey, docPath, forgotten: true };
      },
    });
    return mcpEnvelopeResult(envelope);
  });
}
