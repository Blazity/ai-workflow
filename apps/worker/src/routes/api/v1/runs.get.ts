import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import type { RunsResponse } from "@shared/contracts";
import { listDashboardRuns } from "../../../services/run-lifecycle/run-reads.js";

export default defineEventHandler(async (event): Promise<RunsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  return { generatedAt, ...(await listDashboardRuns(getQuery(event))) };
});
