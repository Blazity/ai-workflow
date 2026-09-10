import { defineEventHandler, setResponseHeader } from "h3";
import type { DispatchCapacityResponse } from "@shared/contracts";
import { requireDashboardActor, toHttpError } from "../../../../services/auth/index.js";
import { readDispatchCapacity } from "../../../../services/dispatch/index.js";

export default defineEventHandler(
  async (event): Promise<DispatchCapacityResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");

    try {
      await requireDashboardActor(event);
      return await readDispatchCapacity();
    } catch (error) {
      toHttpError(error);
    }
  },
);
