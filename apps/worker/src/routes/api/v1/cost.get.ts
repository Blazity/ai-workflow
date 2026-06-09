import { defineEventHandler, setResponseHeader } from "h3";
import type { CostResponse } from "@shared/contracts";
import { env } from "../../../../env.js";
import { ArthurClient } from "../../../sandbox/arthur-client.js";
import { collectCost } from "../../../lib/overview/collect-cost.js";
import { logger } from "../../../lib/logger.js";

const EMPTY: Omit<CostResponse, "generatedAt" | "available"> = {
  window: { start: "", end: "" },
  totals: { totalTokenCost: 0, totalTokens: 0, traceCount: 0, costPerRun: 0 },
  byModel: [],
  byWorkflow: [],
  daily: [],
};

export default defineEventHandler(async (event): Promise<CostResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();

  // Arthur unconfigured — degrade to the documented empty state (no crash).
  if (!env.GENAI_ENGINE_API_KEY || !env.GENAI_ENGINE_TRACE_ENDPOINT) {
    return { generatedAt, available: false, ...EMPTY, window: { start: generatedAt, end: generatedAt } };
  }

  try {
    const client = ArthurClient.fromTraceEndpoint(
      env.GENAI_ENGINE_TRACE_ENDPOINT,
      env.GENAI_ENGINE_API_KEY,
    );
    // TODO(arthur-verify): bucket_size value ("day") is unconfirmed against a live instance.
    const data = await collectCost(client, { now: new Date(), bucketSize: "day" });
    return { generatedAt, available: true, ...data };
  } catch (err) {
    // Arthur unreachable / 401 / unexpected shape — degrade like runs.get.ts.
    logger.warn({ err: (err as Error).message }, "cost_collect_failed");
    return { generatedAt, available: false, ...EMPTY, window: { start: generatedAt, end: generatedAt } };
  }
});
