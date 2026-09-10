import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import type { WorkflowsResponse } from "@shared/contracts";
import { listWorkflowAggregates } from "../../../services/run-lifecycle/index.js";

export default defineEventHandler(async (event): Promise<WorkflowsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  return { generatedAt, ...(await listWorkflowAggregates(getQuery(event))) };
});
