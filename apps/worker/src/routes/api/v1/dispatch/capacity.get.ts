import { defineEventHandler, setResponseHeader } from "h3";
import type { DispatchCapacityResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { getRequestSettingsSnapshot } from "../../../../services/settings/index.js";
import {
  readDispatchCapacity,
} from "../../../../services/dispatch/capacity-snapshot.js";

export default defineEventHandler(
  async (event): Promise<DispatchCapacityResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");

    try {
      await requireDashboardActor(event);
      return await readDispatchCapacity(await getRequestSettingsSnapshot(event));
    } catch (error) {
      toHttpError(error);
    }
  },
);
