import { defineEventHandler, setResponseHeader } from "h3";
import { collectWorkflows } from "../../../lib/overview/collect-workflows.js";
import type { WorkflowsResponse } from "@shared/contracts";

export default defineEventHandler((event): WorkflowsResponse => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const { rows, total } = collectWorkflows();
  return { generatedAt: new Date().toISOString(), rows, total };
});
