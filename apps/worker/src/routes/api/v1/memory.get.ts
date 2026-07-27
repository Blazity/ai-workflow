import { createError, defineEventHandler, getQuery } from "h3";
import type {
  MemoryDocumentResponse,
  MemoryDocumentsResponse,
} from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import { getMemoryDocument, listMemoryDocuments } from "../../../memory/store.js";

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read-only view of the agent memory kept outside the customer repository.
 *  `subjectKey` + `docPath` select one document (with content); without them
 *  the response is the listing (no content), optionally filtered by ticket. */
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
        const document = await getMemoryDocument(getDb(), subjectKey, docPath);
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
      if (subjectKey !== undefined || docPath !== undefined) {
        throw createError({
          statusCode: 400,
          statusMessage: "subjectKey and docPath must be given together",
        });
      }

      const rows = await listMemoryDocuments(getDb(), {
        ticketKey: stringParam(query.ticketKey),
      });
      return {
        documents: rows.map((row) => ({
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
