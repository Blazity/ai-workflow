import { defineEventHandler, setResponseHeader } from "h3";
import { getWorld } from "workflow/runtime";
import type { WorkflowsResponse } from "@shared/contracts";
import { env } from "../../../../env.js";
import { createAdapters } from "../../../lib/adapters.js";
import {
  collectWorkflows,
  registryRows,
} from "../../../lib/overview/collect-workflows.js";
import { type RunsLister } from "../../../lib/overview/collect-runs.js";
import { logger } from "../../../lib/logger.js";

export default defineEventHandler(async (event): Promise<WorkflowsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  try {
    const adapters = createAdapters();
    const model = env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;

    const { rows, total } = await collectWorkflows({
      runsLister: getWorld().runs as RunsLister,
      issueTracker: adapters.issueTracker,
      jiraBaseUrl: env.JIRA_BASE_URL,
      model,
      now: new Date(),
    });

    return { generatedAt, rows, total };
  } catch (err) {
    // World unavailable (e.g. local dev without the Vercel runtime) — degrade to
    // the static registry with null metrics so the card still lists workflows.
    logger.warn({ err: (err as Error).message }, "workflows_collect_failed");
    const { rows, total } = registryRows();
    return { generatedAt, rows, total };
  }
});
