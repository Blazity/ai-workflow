import { createError, defineEventHandler, setResponseHeader } from "h3";
import type { SystemHealthLastScanResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { canInvite } from "../../../../services/auth/roles.js";
import { readLastSystemHealthScan } from "../../../../services/system/health-scan.js";

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
      return { scan: await readLastSystemHealthScan() };
    } catch (error) {
      toHttpError(error);
    }
  },
);
