import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import type { RunsResponse } from "@shared/contracts";
import { env } from "../../../../env.js";
import { getDb } from "../../../db/client.js";
import { listRuns, parseSearch, parseWindow } from "../../../db/queries/runs-read.js";
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
    // Filtering is parameterized SQL inside the worker: the window is whitelisted
    // to an enum and the search is a bound, wildcard-escaped ILIKE. The dashboard
    // sends typed intent only — never SQL.
    const query = getQuery(event);
    const window = parseWindow(query.window);
    const q = parseSearch(query.q);
    const model = env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;

    const { rows, total, counts } = await listRuns({
      db: getDb(),
      window,
      q,
      now: new Date(),
      jiraBaseUrl: env.JIRA_BASE_URL,
      modelFallback: model,
    });

    return { generatedAt, available: true, rows, total, counts };
  } catch (err) {
    // DB unreachable — degrade to the empty state so the dashboard renders its
    // documented N/A view instead of erroring.
    logger.warn({ err: (err as Error).message }, "runs_list_failed");
    return { generatedAt, ...EMPTY };
  }
});
