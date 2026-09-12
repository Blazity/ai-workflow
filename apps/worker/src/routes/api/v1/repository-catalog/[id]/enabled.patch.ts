import { createError, defineEventHandler, readBody } from "h3";
import {
  parseRequestBody,
  repositoryCatalogEnabledRequestSchema,
  type RepositoryCatalogMutationResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import {
  engineAllowlistWarnings,
  setRepositoryCatalogEnabled,
} from "../../../../../services/repository-catalog/index.js";
import { repositoryIdFrom } from "../route-id.js";

/** Its own route, and not a field on the profile save, because it is not a
 *  profile change: a run in flight must not find its checks configuration
 *  moved because somebody switched a repository off. */
export default defineEventHandler(
  async (event): Promise<RepositoryCatalogMutationResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = repositoryIdFrom(event);
      const parsed = parseRequestBody(
        repositoryCatalogEnabledRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const mutation = await setRepositoryCatalogEnabled({
        actor: { role: actor.role, id: actor.userId },
        id,
        enabled: parsed.value.enabled,
      });
      // Answered here rather than by the service, because it is not a fact about
      // the catalog: it is the transitional gap between what the catalog now
      // decides and what the engine still decides, and it disappears with the
      // engine stage. Computed from the row that was actually written, so a
      // repository enabled under a different path than the caller guessed is
      // judged by the stored one.
      const warnings = engineAllowlistWarnings({
        enabled: mutation.repository.enabled,
        path: mutation.repository.path,
      });
      return warnings.length > 0 ? { ...mutation, warnings } : mutation;
    } catch (error) {
      toHttpError(error);
    }
  },
);
