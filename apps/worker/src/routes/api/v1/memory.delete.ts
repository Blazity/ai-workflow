import { createError, defineEventHandler, getQuery } from "h3";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import { canDeleteAgentMemory } from "../../../lib/auth/roles.js";
import { deleteMemoryDocument } from "../../../memory/store.js";

/** Subject keys and doc paths the agent writes are short identifiers, so a
 *  longer value is a malformed or hostile request and is rejected before it
 *  reaches the database. */
const MAX_KEY_LENGTH = 512;

function keyParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_KEY_LENGTH
    ? value
    : undefined;
}

/** Hard delete of one agent memory document, for erasure requests and for the
 *  ordinary case of the agent having remembered something false. Both key parts
 *  come from the client, so they are validated here and then reach the database
 *  only as bound parameters of an equality match on the primary key. */
export default defineEventHandler(
  async (event): Promise<{ deleted: true } | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      if (!canDeleteAgentMemory(actor.role)) {
        throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      }

      const query = getQuery(event);
      const subjectKey = keyParam(query.subjectKey);
      const docPath = keyParam(query.docPath);
      if (subjectKey === undefined || docPath === undefined) {
        throw createError({
          statusCode: 400,
          statusMessage: "subjectKey and docPath must be given together",
        });
      }

      const deleted = await deleteMemoryDocument(getDb(), subjectKey, docPath);
      if (!deleted) {
        throw createError({
          statusCode: 404,
          statusMessage: "Memory document not found",
        });
      }
      return { deleted: true };
    } catch (error) {
      toHttpError(error);
    }
  },
);
