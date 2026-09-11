import { defineEventHandler, setResponseHeader } from "h3";
import type { EvalsResponse } from "@shared/contracts";
import { collectEvalSummary } from "../../../services/overview/collect-eval-summary.js";
import { logger } from "../../../services/system/logger.js";

export default defineEventHandler(async (event): Promise<EvalsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();

  try {
    const summary = await collectEvalSummary(new Date());
    if (summary.kind === "not_configured") {
      return {
        available: false,
        generatedAt,
        reason: "Arthur GenAI Engine not configured.",
      };
    }
    if (summary.kind === "nothing_graded") {
      return {
        available: false,
        generatedAt,
        reason: "No graded evals in the last 24h.",
      };
    }

    return {
      available: true,
      generatedAt,
      windowHours: summary.windowHours,
      score: summary.score,
      spansGraded: summary.spansGraded,
      traceCount: summary.traceCount,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "evals_list_failed");
    return {
      available: false,
      generatedAt,
      reason: "Eval grading not wired up yet.",
    };
  }
});
