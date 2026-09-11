import { defineEventHandler, setResponseHeader } from "h3";
import type { LiveRunsResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { listLiveRuns } from "../../../../services/run-lifecycle/run-reads.js";

export default defineEventHandler(
  async (event): Promise<LiveRunsResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");

    try {
      // Guarded: the awaiting rows carry the parked runs' question texts.
      await requireDashboardActor(event);
      return await listLiveRuns();
    } catch (error) {
      toHttpError(error);
    }
  },
);
