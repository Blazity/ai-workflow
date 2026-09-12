import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import {
  parseRequestBody,
  repositoryCatalogUpsertRequestSchema,
  type RepositoryCatalogMutationResponse,
  type RepositoryCatalogProfileConflict,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import {
  RepositoryProfileConflictError,
  saveRepositoryProfile,
} from "../../../../services/repository-catalog/index.js";
import { repositoryIdOrNewFrom } from "./route-id.js";

/**
 * Save a repository's profile, minting its next version.
 *
 * Identity is the provider and path on the body, not the route id: the same
 * request creates a repository the catalog has never seen, and the dashboard
 * says so by sending 0. The id is still checked when it is non-zero, so a
 * screen left open on one repository cannot overwrite another's profile
 * because the body was edited underneath it.
 *
 * A stale `expectedProfileVersion` is answered with 409 and a BODY naming the
 * current version, the way a stale pre-PR checks save is. A bare status would
 * leave the screen unable to tell "reload, somebody else saved" from "the
 * request was wrong".
 */
export default defineEventHandler(
  async (
    event,
  ): Promise<
    RepositoryCatalogMutationResponse | RepositoryCatalogProfileConflict | undefined
  > => {
    try {
      const actor = await requireDashboardActor(event);
      const id = repositoryIdOrNewFrom(event);
      const parsed = parseRequestBody(
        repositoryCatalogUpsertRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await saveRepositoryProfile({
        actor: { role: actor.role, id: actor.userId },
        request: parsed.value,
        expectedId: id,
      });
    } catch (error) {
      if (error instanceof RepositoryProfileConflictError) {
        setResponseStatus(event, 409);
        return {
          error: "repository_profile_conflict",
          currentVersion: error.currentVersion,
        };
      }
      toHttpError(error);
    }
  },
);
