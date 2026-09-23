import { createError, defineEventHandler, readBody } from "h3";
import {
  integrationEnabledRequestSchema,
  parseRequestBody,
  type IntegrationMutationResponse,
} from "@shared/contracts";

import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import { setIntegrationEnabledState } from "../../../../../services/integrations/index.js";
import { integrationIdFrom } from "../route-id.js";

/**
 * The kill switch, for either source.
 *
 * Mints no version and touches no value, so re-enabling finds exactly what was
 * there and a run in flight does not read this as a reconfiguration. It is read
 * live at every use, so the next dispatch after this request already sees it.
 */
export default defineEventHandler(
  async (event): Promise<IntegrationMutationResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const integrationId = integrationIdFrom(event);
      const parsed = parseRequestBody(
        integrationEnabledRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await setIntegrationEnabledState({
        actor: { role: actor.role, id: actor.userId },
        integrationId,
        enabled: parsed.value.enabled,
      });
    } catch (error) {
      toHttpError(error);
    }
  },
);
