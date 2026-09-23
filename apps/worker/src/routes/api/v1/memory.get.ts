import { createError, defineEventHandler, getQuery } from "h3";
import type {
  MemoryDocumentResponse,
  MemoryDocumentsResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import {
  isUsableMemoryKeyPart,
  listMemoryDocumentSummaries,
  readMemoryDocument,
} from "../../../services/memory/memory-documents.js";

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read-only view of the agent memory kept outside the customer repository.
 *  `subjectKey` + `docPath` select one document (with content). Anything else
 *  is the listing (no content), narrowed to one subject by `subjectKey` alone
 *  and to one ticket by `ticketKey`. */
export default defineEventHandler(
  async (
    event,
  ): Promise<MemoryDocumentsResponse | MemoryDocumentResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const query = getQuery(event);
      const subjectKey = stringParam(query.subjectKey);
      const docPath = stringParam(query.docPath);

      if (subjectKey !== undefined && docPath !== undefined) {
        const read = await readMemoryDocument(subjectKey, docPath);
        if (!read.ok) {
          // Never 404. "This provider could not answer" and "no such document"
          // send a person to two different places, and only one of them means
          // their memory is gone. The same split as the listing below: a
          // provider that is away is 503 because retrying is the right advice,
          // a provider serving runs without an enumerable store is 501 because
          // retrying will never work.
          throw createError({
            statusCode: read.listable ? 503 : 501,
            statusMessage: read.reason,
          });
        }
        const document = read.document;
        if (!document) {
          throw createError({
            statusCode: 404,
            statusMessage: "Memory document not found",
          });
        }
        return {
          document: {
            subjectKey,
            docPath,
            bytes: document.bytes,
            sourceRunId: document.sourceRunId,
            updatedAt: document.updatedAt.toISOString(),
            content: document.content,
          },
        };
      }
      if (docPath !== undefined) {
        throw createError({
          statusCode: 400,
          statusMessage: "docPath needs the subjectKey it is stored under",
        });
      }
      // Bounded like every other key part a client sends, before it reaches a
      // provider's query.
      if (subjectKey !== undefined && !isUsableMemoryKeyPart(subjectKey)) {
        throw createError({
          statusCode: 400,
          statusMessage: "subjectKey is not a memory key the agent could have written",
        });
      }

      const ticketKey = stringParam(query.ticketKey);
      const listing = await listMemoryDocumentSummaries({
        ...(ticketKey === undefined ? {} : { ticketKey }),
        ...(subjectKey === undefined ? {} : { subjectKey }),
      });
      if (!listing.ok) {
        // An empty list would be a lie: this deployment's memory could not be
        // listed, which is not the same as holding nothing. `listable: false`
        // is the provider serving runs without an enumerable store, so it is
        // 501 rather than 503: retrying will not change it.
        throw createError({
          statusCode: listing.listable ? 503 : 501,
          statusMessage: listing.reason,
        });
      }
      return {
        complete: listing.complete,
        documents: listing.documents.map((row) => ({
          subjectKey: row.subjectKey,
          docPath: row.docPath,
          ticketKey: row.ticketKey,
          bytes: row.bytes,
          sourceRunId: row.sourceRunId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
