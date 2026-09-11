/**
 * One run as the detail page reads it: header, step waterfall, analysis report
 * and the clarification Q&A.
 *
 * Two sources answer the same question and neither answers all of it. The
 * durable row carries the persisted waterfall and the ticket/PR refs; the
 * Workflow world carries the live lifecycle of a run still in flight and
 * nothing else. Which one wins, what is merged from the other, and what a
 * failure of either degrades to is decided here, so the route only stamps a
 * timestamp on the result.
 */
import { getWorld } from "workflow/runtime";
import type { RunDetailResponse } from "@shared/contracts";
import {
  fetchConnectedRunDetailFromDb,
  fetchConnectedRunRefs,
} from "./durable-run-detail.js";
import {
  getConnectedClarificationForRun,
  serializeClarification,
} from "../../db/repositories/clarifications.js";
import { logger } from "../../infra/logger.js";
import {
  resolveRunDetail,
  sanitizeRunDetailForResponse,
} from "../overview/index.js";
import {
  collectRunDetail,
  type RunDetailSource,
} from "../../engine/support/collect-run-detail.js";
import { issueTrackerBaseUrl } from "../settings/index.js";

/** The detail payload as the wire carries it, minus the timestamp the route stamps. */
export type RunDetailPayload = Omit<RunDetailResponse, "generatedAt">;

const EMPTY: RunDetailPayload = {
  available: false,
  run: null,
  steps: [],
  analysisReport: null,
};

/** The empty state, for a request that never names a run. */
export function emptyRunDetail(): RunDetailPayload {
  return EMPTY;
}

export async function readRunDetail(runId: string): Promise<RunDetailPayload> {
  const jiraBaseUrl = issueTrackerBaseUrl();

  // Best-effort: the run detail must never 500 because the clarification lookup
  // hiccuped, so a lookup error degrades to no clarification rather than failing.
  const clarification = await getConnectedClarificationForRun(runId)
    .then((row) => (row ? serializeClarification(row) : null))
    .catch(() => null);

  try {
    // Read the durable row first: it carries the persisted waterfall (finished
    // runs) plus the ticket/PR refs the world lacks, and is the coarse fallback.
    const dbDetail = await fetchConnectedRunDetailFromDb({
      runId,
      jiraBaseUrl,
    }).catch(() => null);
    let analysisReport = dbDetail?.analysisReport ?? null;
    if (!analysisReport) {
      analysisReport = await (await import("../../run-analysis/persistence.js"))
        .getConnectedRunAnalysisReport(runId)
        .catch(() => null);
    }

    const result = await resolveRunDetail({
      dbDetail,
      // In-flight runs: the world carries the live lifecycle + step waterfall but
      // not the ticket (encrypted input) or PR, so merge those from the durable row.
      loadWorld: async () => {
        // The world has no model at all, and the durable row is the only thing
        // that can attribute one (see attributeRunModel), so carry it into the
        // world-sourced header so the live trace and the run list agree, and
        // stay null rather than naming the org default when nothing attributes.
        const [{ run, steps }, refs] = await Promise.all([
          collectRunDetail({
            world: getWorld() as unknown as RunDetailSource,
            model: dbDetail?.run.model ?? null,
            runId,
          }),
          fetchConnectedRunRefs(runId, jiraBaseUrl).catch(() => null),
        ]);
        run.prNumber = refs?.prNumber ?? null;
        run.prUrl = refs?.prUrl ?? null;
        run.prs = refs?.prs ?? null;
        if (refs?.ticketKey) {
          run.ticket = refs.ticketKey;
          run.ticketUrl = refs.ticketUrl ?? "";
          run.ticketTitle = refs.ticketTitle || refs.ticketKey;
        }
        // The world's cancelled runs carry no error, so a blocked run would
        // render reason-less; fall back to the durable status reason. Always
        // prefer the DB's statusReason when one is recorded.
        if (refs?.statusReason) {
          run.statusReason = refs.statusReason;
          if (!run.error && (run.status === "blocked" || run.status === "failed")) {
            run.error = { message: refs.statusReason };
          }
        }
        return { run, steps };
      },
    });

    if (!result) return EMPTY;
    const safe = sanitizeRunDetailForResponse(result);
    return {
      available: true,
      run: safe.run,
      steps: safe.steps,
      analysisReport: analysisReport ?? null,
      clarification,
    };
  } catch (err) {
    // World unavailable (local dev), or the run aged out of the ~24h step
    // window (an expired-run lookup throws). Fall back to the durable
    // workflow_runs telemetry: header + a phase waterfall synthesized from the
    // persisted per-phase breakdown, so old runs still render.
    logger.warn({ err: errorMessage(err), runId }, "run_detail_failed");
    try {
      const fallback = await fetchConnectedRunDetailFromDb({
        runId,
        jiraBaseUrl,
      });
      if (fallback) {
        const safe = sanitizeRunDetailForResponse(fallback);
        return {
          available: true,
          run: safe.run,
          steps: safe.steps,
          analysisReport: fallback.analysisReport ?? null,
          clarification,
        };
      }
    } catch (dbErr) {
      logger.warn({ err: errorMessage(dbErr), runId }, "run_detail_db_fallback_failed");
    }
    return EMPTY;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
