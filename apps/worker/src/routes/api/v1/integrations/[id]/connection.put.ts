import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import {
  integrationConnectionSaveRequestSchema,
  parseRequestBody,
  type IntegrationMutationResponse,
  type IntegrationVersionConflict,
} from "@shared/contracts";

import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import {
  IntegrationVersionConflictError,
  saveIntegrationConnection,
} from "../../../../../services/integrations/index.js";
import { integrationIdFrom } from "../route-id.js";

/**
 * Store values for one integration: tested first, in use only if the test
 * passed.
 *
 * A stale `expectedVersion` is answered with 409 and a BODY naming the current
 * version, the way a stale repository profile save is: a bare status would leave
 * a second tab unable to tell "somebody else saved, reload" from "the request
 * was wrong".
 *
 * The response carries the test outcome next to the new state, so the screen can
 * say what the provider said without a second request.
 */
export default defineEventHandler(
  async (
    event,
  ): Promise<IntegrationMutationResponse | IntegrationVersionConflict | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const integrationId = integrationIdFrom(event);
      const parsed = parseRequestBody(
        integrationConnectionSaveRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await saveIntegrationConnection({
        actor: { role: actor.role, id: actor.userId },
        integrationId,
        expectedVersion: parsed.value.expectedVersion,
        values: parsed.value.values,
        clearSecrets: parsed.value.clearSecrets,
      });
    } catch (error) {
      if (error instanceof IntegrationVersionConflictError) {
        setResponseStatus(event, 409);
        return {
          error: "integration_version_conflict",
          currentVersion: error.currentVersion,
        };
      }
      toHttpError(error);
    }
  },
);
