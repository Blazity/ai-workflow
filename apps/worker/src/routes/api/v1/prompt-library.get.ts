import { createError, defineEventHandler, getQuery, getRouterParam, type H3Event } from "h3";
import type {
  PromptLibraryListResponse,
  PromptLibraryListRowDto,
} from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import {
  listPrompts,
  PromptLibraryStoreError,
  serializePromptMeta,
  type PromptLibraryListRow,
} from "../../../prompt-library/store.js";

/** Serializes a list row into its DTO (meta + head body and slot contract). */
export function serializeListRow(row: PromptLibraryListRow): PromptLibraryListRowDto {
  return {
    ...serializePromptMeta(row, row.currentVersion),
    body: row.body,
    slots: structuredClone(row.slots),
  };
}

/** Maps a store write failure (400/404/409) to its HTTP error, then defers the
 *  rest (403 DashboardAuthError, etc.) to the shared toHttpError. */
export function toPromptLibraryHttpError(error: unknown): never {
  if (error instanceof PromptLibraryStoreError) {
    throw createError({ statusCode: error.statusCode, statusMessage: error.message });
  }
  toHttpError(error);
}

/** Reads and validates the `[id]` route segment shared by the detail routes. */
export function parsePromptId(event: H3Event): number {
  const id = Number(getRouterParam(event, "id"));
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    throw createError({ statusCode: 404, statusMessage: "Unknown prompt" });
  }
  return id;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export default defineEventHandler(async (event): Promise<PromptLibraryListResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    const query = getQuery(event);
    const includeArchived = query.includeArchived === "1" || query.includeArchived === "true";
    const rows = await listPrompts(getDb(), {
      q: stringParam(query.q),
      tag: stringParam(query.tag),
      includeArchived,
    });

    const prompts = rows.map(serializeListRow);
    const tags = [...new Set(prompts.flatMap((p) => p.tags))].sort();
    return { prompts, tags };
  } catch (error) {
    toHttpError(error);
  }
});
