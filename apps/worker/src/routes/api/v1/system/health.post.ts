import { createError, defineEventHandler, setResponseHeader } from "h3";
import type { SystemHealthResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { canInvite } from "../../../../services/auth/roles.js";
import { getRequestSettingsSnapshot } from "../../../../services/settings/index.js";
import { runSystemHealthScan } from "../../../../services/system/health-scan.js";

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
      return await runSystemHealthScan(await getRequestSettingsSnapshot(event));
    } catch (error) {
      toHttpError(error);
    }
  },
);
