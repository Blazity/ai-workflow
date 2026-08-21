import { createError, defineEventHandler, setResponseHeader } from "h3";
import type { SystemHealthResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import { canInvite } from "../../../../lib/auth/roles.js";
import { saveSystemHealthScan } from "../../../../system-health/last-scan.js";
import { collectDeploymentSystemHealth } from "../../../../system-health/probes.js";

/** The only way a scan runs: an explicit request from the Health screen's
 * Scan button. Nothing renders, polls, or schedules this in the background.
 * The result is stored so the next visit shows it without scanning again. */
export default defineEventHandler(
  async (event): Promise<SystemHealthResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");
    try {
      const actor = await requireDashboardActor(event);
      if (!canInvite(actor.role)) {
        throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      }
      const report = await collectDeploymentSystemHealth();
      await saveSystemHealthScan(getDb(), report);
      return report;
    } catch (error) {
      toHttpError(error);
    }
  },
);
