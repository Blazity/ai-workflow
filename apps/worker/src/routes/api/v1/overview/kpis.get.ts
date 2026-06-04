import { defineEventHandler, setResponseHeader } from "h3";
import { getWorld } from "workflow/runtime";
import type { KpisResponse } from "@shared/contracts";
import { collectKpis } from "../../../../lib/overview/collect-kpis.js";
import { type RunsLister } from "../../../../lib/overview/collect-runs.js";
import { logger } from "../../../../lib/logger.js";

export default defineEventHandler(async (event): Promise<KpisResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  try {
    const kpis = await collectKpis({
      runsLister: getWorld().runs as RunsLister,
      now: new Date(),
    });
    return { generatedAt, ...kpis };
  } catch (err) {
    // World unavailable (e.g. local dev without the Vercel runtime) — degrade to
    // the documented N/A state instead of erroring.
    logger.warn({ err: (err as Error).message }, "kpis_collect_failed");
    return { generatedAt, runs24h: null, p95: null, errors24h: null, cost24h: null };
  }
});
