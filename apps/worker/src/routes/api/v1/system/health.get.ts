import { createError, defineEventHandler, setResponseHeader } from "h3";
import type { SystemHealthResponse } from "@shared/contracts";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import { canInvite } from "../../../../lib/auth/roles.js";
import { collectDeploymentSystemHealth } from "../../../../system-health/probes.js";

export default defineEventHandler(
  async (event): Promise<SystemHealthResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");
    try {
      const actor = await requireDashboardActor(event);
      if (!canInvite(actor.role)) {
        throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      }
      return await collectDeploymentSystemHealth();
    } catch (error) {
      toHttpError(error);
    }
  },
);
