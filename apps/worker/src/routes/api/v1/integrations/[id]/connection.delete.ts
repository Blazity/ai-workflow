import { defineEventHandler } from "h3";
import type { IntegrationMutationResponse } from "@shared/contracts";

import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import { disconnectIntegrationConnection } from "../../../../../services/integrations/index.js";
import { integrationIdFrom } from "../route-id.js";

/** Forget every stored value and every stored secret, in every past version, and
 *  hand the connection back to the environment. Who saved what, and when, stays. */
export default defineEventHandler(
  async (event): Promise<IntegrationMutationResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      return await disconnectIntegrationConnection({
        actor: { role: actor.role, id: actor.userId },
        integrationId: integrationIdFrom(event),
      });
    } catch (error) {
      toHttpError(error);
    }
  },
);
