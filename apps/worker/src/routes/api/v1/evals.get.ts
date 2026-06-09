import { defineEventHandler, setResponseHeader } from "h3";
import type { EvalsResponse } from "@shared/contracts";
import { env } from "../../../../env.js";
import { ArthurClient } from "../../../sandbox/arthur-client.js";
import { collectEvals } from "../../../lib/overview/collect-evals.js";
import { logger } from "../../../lib/logger.js";

const WINDOW_HOURS = 24;

export default defineEventHandler(async (event): Promise<EvalsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();

  if (!env.GENAI_ENGINE_API_KEY || !env.GENAI_ENGINE_TRACE_ENDPOINT) {
    return {
      available: false,
      generatedAt,
      reason: "Arthur GenAI Engine not configured.",
    };
  }

  try {
    const client = ArthurClient.fromTraceEndpoint(
      env.GENAI_ENGINE_TRACE_ENDPOINT,
      env.GENAI_ENGINE_API_KEY,
    );
    // TODO(arthur-verify): pass [] if empty task_ids === all org tasks on
    // POST /api/v1/traces/overview; otherwise enumerate via /api/v2/tasks/search.
    const taskIds: string[] = [];

    const { windowHours, score, spansGraded, traceCount } =
      await collectEvals({
        client,
        taskIds,
        windowHours: WINDOW_HOURS,
        now: new Date(),
      });

    if (spansGraded === 0) {
      return {
        available: false,
        generatedAt,
        reason: "No graded evals in the last 24h.",
      };
    }

    return {
      available: true,
      generatedAt,
      windowHours,
      score,
      spansGraded,
      traceCount,
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
