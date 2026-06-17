import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import type { WorkflowsResponse } from "@shared/contracts";
import { env } from "../../../../env.js";
import { getDb } from "../../../db/client.js";
import { parseWindow, workflowAgg } from "../../../db/queries/runs-read.js";
import { getWorkflowRegistry } from "../../../lib/overview/workflow-registry.js";
import { registryRows } from "../../../lib/overview/collect-workflows.js";
import { logger } from "../../../lib/logger.js";

export default defineEventHandler(async (event): Promise<WorkflowsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  try {
    const window = parseWindow(getQuery(event).window);
    const { rows, total } = await workflowAgg({
      db: getDb(),
      window,
      now: new Date(),
      jiraBaseUrl: env.JIRA_BASE_URL,
      registry: getWorkflowRegistry(),
    });
    return { generatedAt, rows, total };
  } catch (err) {
    // DB unreachable — degrade to the static registry with null metrics so the
    // card still lists the workflows.
    logger.warn({ err: (err as Error).message }, "workflows_collect_failed");
    const { rows, total } = registryRows();
    return { generatedAt, rows, total };
  }
});
