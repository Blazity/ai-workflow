import { createError, defineEventHandler, setResponseHeader } from "h3";
import type { SystemHealthLastScanResponse } from "@shared/contracts";
import {
  canInvite,
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/index.js";
import { readLastSystemHealthScan } from "../../../../services/system/index.js";

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
