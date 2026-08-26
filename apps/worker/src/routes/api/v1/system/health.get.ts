import { createError, defineEventHandler, setResponseHeader } from "h3";
import type { SystemHealthLastScanResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import { canInvite } from "../../../../lib/auth/roles.js";
import { readSystemHealthScan } from "../../../../system-health/last-scan.js";

/** Returns the stored result of the last scan. This never probes anything;
 * the only way to refresh it is the POST behind the Scan button. */
export default defineEventHandler(
  async (event): Promise<SystemHealthLastScanResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");
    try {
      const actor = await requireDashboardActor(event);
      if (!canInvite(actor.role)) {
        throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      }
      return { scan: await readSystemHealthScan(getDb()) };
    } catch (error) {
      toHttpError(error);
    }
  },
);
