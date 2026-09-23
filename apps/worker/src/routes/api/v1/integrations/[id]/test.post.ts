import { defineEventHandler } from "h3";
import type { IntegrationMutationResponse } from "@shared/contracts";

import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import { testIntegrationConnection } from "../../../../../services/integrations/index.js";
import { integrationIdFrom } from "../route-id.js";

/**
 * Ask the provider about the configuration in use right now.
 *
 * Works for either source, because an environment-configured integration is the
 * one an admin most wants to be able to check: its values arrived by redeploy
 * and nothing has ever asked the provider about them.
 *
 * Takes no body: it tests what is live, never values the request carried.
 */
export default defineEventHandler(
  async (event): Promise<IntegrationMutationResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      return await testIntegrationConnection({
        actor: { role: actor.role, id: actor.userId },
        integrationId: integrationIdFrom(event),
      });
    } catch (error) {
      toHttpError(error);
    }
  },
);
