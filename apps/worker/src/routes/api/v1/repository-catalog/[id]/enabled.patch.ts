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
import { setRepositoryCatalogEnabled } from "../../../../../services/repository-catalog/index.js";
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
      // Enabling a row is the whole action. Dispatch and in-run access are both
      // decided by the catalog since the engine wave, so there is nothing an
      // operator has to keep in step elsewhere and nothing to warn about.
      return await setRepositoryCatalogEnabled({
        actor: { role: actor.role, id: actor.userId },
        id,
        enabled: parsed.value.enabled,
      });
    } catch (error) {
      toHttpError(error);
    }
  },
);
