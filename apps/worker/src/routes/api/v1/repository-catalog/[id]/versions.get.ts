import { createError, defineEventHandler, getQuery } from "h3";
import {
  parseRequestBody,
  repositoryCatalogVersionsQuerySchema,
  type RepositoryCatalogVersionsResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import { readRepositoryCatalogVersions } from "../../../../../services/repository-catalog/index.js";
import { repositoryIdFrom } from "../route-id.js";

/**
 * One page of a repository's profile history, newest first.
 *
 * Paged, and paged exactly as `repositories.list_versions` is: same default,
 * same ceiling, `before` taking the version number of the oldest row you were
 * given, and `hasMore` saying whether older versions exist. It answered the
 * WHOLE history until stage F, which is a payload cliff on precisely the
 * repositories somebody has configured hardest.
 */
export default defineEventHandler(
  async (event): Promise<RepositoryCatalogVersionsResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const parsed = parseRequestBody(
        repositoryCatalogVersionsQuerySchema,
        getQuery(event),
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await readRepositoryCatalogVersions({
        id: repositoryIdFrom(event),
        ...(parsed.value.limit === undefined ? {} : { limit: parsed.value.limit }),
        ...(parsed.value.before === undefined ? {} : { before: parsed.value.before }),
      });
    } catch (error) {
      toHttpError(error);
    }
  },
);
