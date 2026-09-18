import { createError, defineEventHandler, readBody } from "h3";
import {
  integrationSourceRequestSchema,
  parseRequestBody,
  type IntegrationMutationResponse,
} from "@shared/contracts";

import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import { setIntegrationConnectionSource } from "../../../../../services/integrations/index.js";
import { integrationIdFrom } from "../route-id.js";

/**
 * Switch which source is live, in one action and with no redeploy.
 *
 * Refused with 409 when the source being switched to is not complete, naming
 * what is missing: swapping a working connection for a half-configured one is
 * not what "use the environment instead" means.
 */
export default defineEventHandler(
  async (event): Promise<IntegrationMutationResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const integrationId = integrationIdFrom(event);
      const parsed = parseRequestBody(
        integrationSourceRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await setIntegrationConnectionSource({
        actor: { role: actor.role, id: actor.userId },
        integrationId,
        source: parsed.value.source,
      });
    } catch (error) {
      toHttpError(error);
    }
  },
);
