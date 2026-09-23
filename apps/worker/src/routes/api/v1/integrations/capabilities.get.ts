import { defineEventHandler } from "h3";
import type { IntegrationCapabilitiesResponse } from "@shared/contracts";

import { requireDashboardActor, toHttpError } from "../../../../services/auth/request-context.js";
import { readCapabilityOverview } from "../../../../services/capabilities/index.js";

/**
 * Which provider serves each capability on this deployment, the built-in one
 * included, so the Integrations page can say what memory runs on even when no
 * integration serves it.
 *
 * Open to every role, like the list beside it: it names providers and carries
 * no connection value. Read-only; choosing the active provider of a capability
 * is a write this build does not have yet.
 */
export default defineEventHandler(
  async (event): Promise<IntegrationCapabilitiesResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      return await readCapabilityOverview();
    } catch (error) {
      toHttpError(error);
    }
  },
);
