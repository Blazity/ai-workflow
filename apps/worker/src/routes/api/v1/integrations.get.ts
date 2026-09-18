import { defineEventHandler } from "h3";
import type { IntegrationsListResponse } from "@shared/contracts";

import { listIntegrations } from "../../../services/integrations/index.js";
import { requireDashboardActor, toHttpError } from "../../../services/auth/request-context.js";

/**
 * Every integration this build ships, what it needs to connect, what it
 * unlocks, and what state it is in.
 *
 * Open to every role. Nothing here carries a credential: a secret field reports
 * only whether one is stored, and the resolver's state has nowhere to put a
 * value. A member who could not read this could not tell a deployment that is
 * quiet from one that is broken.
 *
 * `writes` says whether this deployment may change any of it, so a screen can
 * explain itself before an admin clicks rather than after.
 */
export default defineEventHandler(async (event): Promise<IntegrationsListResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    return await listIntegrations();
  } catch (error) {
    toHttpError(error);
  }
});
