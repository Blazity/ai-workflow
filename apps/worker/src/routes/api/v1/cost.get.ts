import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import type { CostResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { costAgg, parseWindow } from "../../../db/queries/runs-read.js";
import { logger } from "../../../lib/logger.js";

const EMPTY: Omit<CostResponse, "generatedAt" | "available" | "window"> = {
  totals: { totalTokenCost: 0, totalTokens: 0, traceCount: 0, costPerRun: 0 },
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
  try {
    const window = parseWindow(getQuery(event).window);
    const data = await costAgg({ db: getDb(), window, now: new Date() });
    // Empty window → documented empty state (matches the prior Arthur behaviour).
    return { generatedAt, available: data.totals.traceCount > 0, ...data };
  } catch (err) {
    // DB unreachable — degrade like the other collectors.
    logger.warn({ err: (err as Error).message }, "cost_collect_failed");
    return {
      generatedAt,
      available: false,
      window: { start: generatedAt, end: generatedAt },
      ...EMPTY,
    };
  }
});
