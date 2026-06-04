import { defineEventHandler, setResponseHeader } from "h3";
import { env } from "../../../../../env.js";
import { createAdapters } from "../../../../lib/adapters.js";
import { collectLiveRuns } from "../../../../lib/overview/collect-live-runs.js";
import { collectAwaitingRuns } from "../../../../lib/overview/collect-awaiting-runs.js";
import type { LiveRunsResponse } from "@shared/contracts";

export default defineEventHandler(async (event): Promise<LiveRunsResponse> => {
  setResponseHeader(event, "Cache-Control", "no-store");

  const adapters = createAdapters();
  const model =
    env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;

  const now = new Date();
  const [running, awaiting] = await Promise.all([
    collectLiveRuns({
      registry: adapters.runRegistry,
      issueTracker: adapters.issueTracker,
      jiraBaseUrl: env.JIRA_BASE_URL,
      model,
    }),
    collectAwaitingRuns({
      issueTracker: adapters.issueTracker,
      projectKey: env.JIRA_PROJECT_KEY,
      backlogColumn: env.COLUMN_BACKLOG,
      jiraBaseUrl: env.JIRA_BASE_URL,
      model,
      now,
    }),
  ]);

  return { generatedAt: now.toISOString(), rows: [...running, ...awaiting] };
});
