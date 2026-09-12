import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import {
  parseRequestBody,
  repositoryCatalogActivateRequestSchema,
  type RepositoryCatalogActivateConflict,
  type RepositoryCatalogActivateResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { activateRepositoryCatalog } from "../../../../services/repository-catalog/index.js";

/**
 * End the bridge.
 *
 * A 409 carrying the repositories the admin has not acknowledged is the normal
 * path, not an error path: it is how the dialog learns what to render. The
 * admin confirms against that list and the second request goes through.
 */
export default defineEventHandler(
  async (
    event,
  ): Promise<
    RepositoryCatalogActivateResponse | RepositoryCatalogActivateConflict | undefined
  > => {
    try {
      const actor = await requireDashboardActor(event);
      const parsed = parseRequestBody(
        repositoryCatalogActivateRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const outcome = await activateRepositoryCatalog({
        actor: { role: actor.role, id: actor.userId },
        acknowledgedRepositoryKeys: parsed.value.acknowledgedRepositoryKeys,
      });
      if (outcome.kind === "unacknowledged") {
        setResponseStatus(event, 409);
        return {
          error: "unacknowledged_repositories",
          repositories: outcome.repositories,
        };
      }
      return outcome.response;
    } catch (error) {
      toHttpError(error);
    }
  },
);
