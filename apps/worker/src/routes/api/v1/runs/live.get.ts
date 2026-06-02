import { defineEventHandler, setResponseHeader } from "h3";
import { env } from "../../../../../env.js";
import { createAdapters } from "../../../../lib/adapters.js";
import { collectLiveRuns } from "../../../../lib/overview/collect-live-runs.js";
import type { LiveRunsResponse } from "@shared/contracts";

export default defineEventHandler(async (event): Promise<LiveRunsResponse> => {
  setResponseHeader(event, "Cache-Control", "no-store");

  const adapters = createAdapters();
  const model =
    env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;

  const rows = await collectLiveRuns({
    registry: adapters.runRegistry,
    issueTracker: adapters.issueTracker,
    jiraBaseUrl: env.JIRA_BASE_URL,
    model,
  });

  return { generatedAt: new Date().toISOString(), rows };
});
