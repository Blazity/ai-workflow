import { defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { getWorld } from "workflow/runtime";
import type { RunDetailResponse } from "@shared/contracts";
import { env } from "../../../../../env.js";
import { createAdapters } from "../../../../lib/adapters.js";
import {
  collectRunDetail,
  type RunDetailSource,
} from "../../../../lib/overview/collect-run-detail.js";
import { logger } from "../../../../lib/logger.js";

const EMPTY: Omit<RunDetailResponse, "generatedAt"> = {
  available: false,
  run: null,
  steps: [],
};

export default defineEventHandler(async (event): Promise<RunDetailResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  const runId = getRouterParam(event, "runId");
  if (!runId) return { generatedAt, ...EMPTY };

  try {
    const adapters = createAdapters();
    const model =
      env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;

    const { run, steps } = await collectRunDetail({
      world: getWorld() as unknown as RunDetailSource,
      issueTracker: adapters.issueTracker,
      jiraBaseUrl: env.JIRA_BASE_URL,
      projectKey: env.JIRA_PROJECT_KEY,
      model,
      runId,
    });

    return { generatedAt, available: true, run, steps };
  } catch (err) {
    // World unavailable (local dev without the Vercel runtime) or unknown run
    // — degrade to the documented N/A state instead of a 500.
    logger.warn(
      { err: errorMessage(err), runId },
      "run_detail_failed",
    );
    return { generatedAt, ...EMPTY };
  }
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
