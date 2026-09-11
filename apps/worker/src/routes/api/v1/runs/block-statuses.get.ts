import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import type { RunBlockStatusesResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { readRunBlockStatuses } from "../../../../services/run-lifecycle/run-reads.js";

export default defineEventHandler(
  async (event): Promise<RunBlockStatusesResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");

    try {
      await requireDashboardActor(event);
      return {
        generatedAt: new Date().toISOString(),
        run: await readRunBlockStatuses(getQuery(event)),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
