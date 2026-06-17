import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import type { KpisResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { parseWindow, runKpis } from "../../../../db/queries/runs-read.js";
import { logger } from "../../../../lib/logger.js";

export default defineEventHandler(async (event): Promise<KpisResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  try {
    const window = parseWindow(getQuery(event).window);
    const kpis = await runKpis({ db: getDb(), window, now: new Date() });
    return { generatedAt, ...kpis };
  } catch (err) {
    // DB unreachable — degrade to the documented N/A state instead of erroring.
    logger.warn({ err: (err as Error).message }, "kpis_collect_failed");
    return { generatedAt, runs24h: null, p95: null, errors24h: null, cost24h: null };
  }
});
