import { defineEventHandler, getQuery } from "h3";
import type { RepositoryCatalogSuggestionsResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import { readRepositorySuggestions } from "../../../../../services/repository-catalog/index.js";
import { repositoryIdFrom } from "../route-id.js";

/**
 * What this repository's suggestions have cost, newest first.
 *
 * A read, so owner, admin and viewer all get it: what a deployment spent asking
 * a model about its own repositories is not a privilege, and the History tab
 * that shows it sits beside the profile versions every role can already read.
 *
 * Paginated by an opaque cursor rather than by an offset, because rows are only
 * ever appended and an offset page would shift under a reader the moment
 * somebody asks for another suggestion.
 */
export default defineEventHandler(
  async (event): Promise<RepositoryCatalogSuggestionsResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const cursor = getQuery(event).cursor;
      return await readRepositorySuggestions({
        id: repositoryIdFrom(event),
        cursor: typeof cursor === "string" ? cursor : null,
      });
    } catch (error) {
      toHttpError(error);
    }
  },
);
