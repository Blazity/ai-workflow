import { defineEventHandler, setResponseHeader } from "h3";
import type { PromptsResponse } from "@shared/contracts";
import { resolvePrompts } from "../../../lib/overview/collect-prompts.js";
import { logger } from "../../../lib/logger.js";

export default defineEventHandler(async (event): Promise<PromptsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  try {
    const { arthurEnabled, prompts } = await resolvePrompts({ withVersions: true });
    return {
      generatedAt,
      available: true,
      arthurEnabled,
      rows: prompts,
      total: prompts.length,
    };
  } catch (err) {
    // Arthur unreachable / unexpected failure — degrade to the documented empty
    // state so the dashboard renders its N/A view instead of a 500.
    logger.warn({ err: (err as Error).message }, "prompts_resolve_failed");
    return { generatedAt, available: false, arthurEnabled: false, rows: [], total: 0 };
  }
});
