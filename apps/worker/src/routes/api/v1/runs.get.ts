import { defineEventHandler, setResponseHeader } from "h3";
import { getWorld } from "workflow/runtime";
import type { RunsResponse } from "@shared/contracts";
import { env } from "../../../../env.js";
import { createAdapters } from "../../../lib/adapters.js";
import { collectRuns, type RunsLister } from "../../../lib/overview/collect-runs.js";
import { logger } from "../../../lib/logger.js";

const EMPTY: Omit<RunsResponse, "generatedAt"> = {
  available: false,
  rows: [],
  total: 0,
  counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
};

export default defineEventHandler(async (event): Promise<RunsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  try {
    const adapters = createAdapters();
    const model = env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;

    const { rows, total, counts } = await collectRuns({
      runsLister: getWorld().runs as RunsLister,
      issueTracker: adapters.issueTracker,
      jiraBaseUrl: env.JIRA_BASE_URL,
      model,
      now: new Date(),
    });

    return { generatedAt, available: true, rows, total, counts };
  } catch (err) {
    // World unavailable (e.g. local dev without the Vercel runtime) — degrade to
    // the empty state so the dashboard renders its documented N/A view.
    logger.warn({ err: (err as Error).message }, "runs_list_failed");
    return { generatedAt, ...EMPTY };
  }
});
