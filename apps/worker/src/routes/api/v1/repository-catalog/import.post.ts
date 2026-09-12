import { createError, defineEventHandler, readBody } from "h3";
import {
  parseRequestBody,
  repositoryCatalogImportRequestSchema,
  type RepositoryCatalogImportResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { commitRepositoryImport } from "../../../../services/repository-catalog/index.js";

/**
 * Create a catalog row for each selected repository.
 *
 * Owner or admin, like every other catalog write. Keys a successful listing did
 * not contain come back in `skipped` rather than as a 400: a stale screen is the
 * ordinary way to send one, and refusing the whole batch because one row moved
 * would cost the admin the other ninety-nine.
 *
 * The one case that IS refused whole is a provider that could not be listed at
 * all: the service answers 503 `provider_unavailable` rather than reporting
 * every repository on that provider as missing.
 */
export default defineEventHandler(
  async (event): Promise<RepositoryCatalogImportResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const parsed = parseRequestBody(
        repositoryCatalogImportRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await commitRepositoryImport({
        actor: { role: actor.role, id: actor.userId },
        request: parsed.value,
      });
    } catch (error) {
      toHttpError(error);
    }
  },
);
