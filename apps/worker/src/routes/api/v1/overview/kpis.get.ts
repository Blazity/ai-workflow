import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import type { KpisResponse } from "@shared/contracts";
import { collectRunKpis } from "../../../../services/overview/index.js";
import { logger } from "../../../../infra/logger.js";

export default defineEventHandler(async (event): Promise<KpisResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  try {
    const kpis = await collectRunKpis(getQuery(event).window, new Date());
    return { generatedAt, ...kpis };
  } catch (err) {
    // DB unreachable, degrade to the documented N/A state instead of erroring.
    logger.warn({ err: (err as Error).message }, "kpis_collect_failed");
    return { generatedAt, runs24h: null, p95: null, errors24h: null, cost24h: null };
  }
});
