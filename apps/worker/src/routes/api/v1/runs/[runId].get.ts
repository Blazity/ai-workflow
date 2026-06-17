import { defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { getWorld } from "workflow/runtime";
import type { RunDetailResponse } from "@shared/contracts";
import { env } from "../../../../../env.js";
import { createAdapters } from "../../../../lib/adapters.js";
import { getDb } from "../../../../db/client.js";
import { fetchRunDetailFromDb, fetchRunRefs } from "../../../../db/queries/run-detail-read.js";
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

    // The Workflow world carries the run's lifecycle but not its PR, and its
    // JQL-based ticket recovery is best-effort (sometimes empty). Read the
    // durable ticket + PR refs in parallel and merge them in. Kept non-fatal:
    // a DB hiccup leaves the world-built header as-is rather than blanking it.
    const [{ run, steps }, refs] = await Promise.all([
      collectRunDetail({
        world: getWorld() as unknown as RunDetailSource,
        issueTracker: adapters.issueTracker,
        jiraBaseUrl: env.JIRA_BASE_URL,
        projectKey: env.JIRA_PROJECT_KEY,
        model,
        runId,
      }),
      fetchRunRefs(getDb(), runId, env.JIRA_BASE_URL).catch(() => null),
    ]);
    run.prNumber = refs?.prNumber ?? null;
    run.prUrl = refs?.prUrl ?? null;
    // Backfill the ticket from the durable row when the world's JQL recovery
    // came back empty, so the Jira link shows alongside the PR link.
    if (!run.ticket && refs?.ticketKey) {
      run.ticket = refs.ticketKey;
      run.ticketUrl = refs.ticketUrl ?? "";
      run.ticketTitle = run.ticketTitle || refs.ticketTitle || refs.ticketKey;
    }

    return { generatedAt, available: true, run, steps };
  } catch (err) {
    // World unavailable (local dev), or the run aged out of the ~24h step
    // window (an expired-run lookup throws). Fall back to the durable
    // workflow_runs telemetry: header + a phase waterfall synthesized from the
    // persisted per-phase breakdown, so old runs still render.
    logger.warn({ err: errorMessage(err), runId }, "run_detail_failed");
    try {
      const model =
        env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
      const fallback = await fetchRunDetailFromDb({
        db: getDb(),
        runId,
        jiraBaseUrl: env.JIRA_BASE_URL,
        modelFallback: model,
      });
      if (fallback) {
        return { generatedAt, available: true, run: fallback.run, steps: fallback.steps };
      }
    } catch (dbErr) {
      logger.warn({ err: errorMessage(dbErr), runId }, "run_detail_db_fallback_failed");
    }
    return { generatedAt, ...EMPTY };
  }
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
