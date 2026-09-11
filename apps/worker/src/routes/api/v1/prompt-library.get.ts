import {
  createError,
  defineEventHandler,
  getQuery,
  getRouterParam,
  type H3Event,
} from "h3";
import type { PromptLibraryListResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import {
  promptLibraryFailure,
} from "../../../services/prompts/prompt-library-failures.js";
import {
  isStorablePromptId,
} from "../../../services/prompts/prompt-library-identifiers.js";
import { listPromptLibrary } from "../../../services/prompts/prompt-library-reads.js";

/** Maps a prompt library write failure (400/404/409) to its HTTP error, then
 *  defers the rest (403 DashboardAuthError, etc.) to the shared toHttpError. */
export function toPromptLibraryHttpError(error: unknown): never {
  const failure = promptLibraryFailure(error);
  if (failure) {
    throw createError({ statusCode: failure.statusCode, statusMessage: failure.message });
  }
  toHttpError(error);
}

/** Reads and validates the `[id]` route segment shared by the detail routes. */
export function parsePromptId(event: H3Event): number {
  const id = Number(getRouterParam(event, "id"));
  if (!isStorablePromptId(id)) {
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
    return await listPromptLibrary({
      q: stringParam(query.q),
      tag: stringParam(query.tag),
      includeArchived: query.includeArchived === "1" || query.includeArchived === "true",
    });
  } catch (error) {
    toHttpError(error);
  }
});
