import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import {
  parseRequestBody,
  repositoryCatalogActivateRequestSchema,
  type RepositoryCatalogActivateBlocked,
  type RepositoryCatalogActivateConflict,
  type RepositoryCatalogActivateResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import {
  activateRepositoryCatalog,
  RepositoryCatalogNoEnabledError,
} from "../../../../services/repository-catalog/index.js";

/**
 * End the bridge.
 *
 * A 409 carrying the repositories the admin has not acknowledged is the normal
 * path, not an error path: it is how the dialog learns what to render. The
 * admin confirms against that list and the second request goes through.
 *
 * What that list actually contains, stated plainly because the dialog has to
 * say it too: **repositories with branches on tickets that currently hold a
 * claim**, and that are not enabled. No table ties a workflow-owned branch to
 * the run that created it, so this cannot be narrowed to "what the live run is
 * writing to right now": a ticket re-run after an earlier run touched a
 * repository still lists that repository. Each entry therefore carries the
 * tickets and run ids it was found through, so the admin can check rather than
 * trust.
 *
 * The second 409 this route answers is the catalog that enables nothing, which
 * the service refuses. This surface keeps the acknowledgement protocol (the
 * dialog echoes the keys it rendered) and the MCP surface keeps the digest
 * protocol; there is no `previewDigest` here, because there is a dialog to
 * render the population in.
 */
export default defineEventHandler(
  async (
    event,
  ): Promise<
    | RepositoryCatalogActivateResponse
    | RepositoryCatalogActivateConflict
    | RepositoryCatalogActivateBlocked
    | undefined
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
        reason: parsed.value.reason,
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
      if (error instanceof RepositoryCatalogNoEnabledError) {
        setResponseStatus(event, 409);
        return { error: "no_enabled_repository", message: error.message };
      }
      toHttpError(error);
    }
  },
);
