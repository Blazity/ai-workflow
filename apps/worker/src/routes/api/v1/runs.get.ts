import { defineEventHandler, setResponseHeader } from "h3";
import type { RunsResponse } from "@shared/contracts";

export default defineEventHandler((event): RunsResponse => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );
  return {
    generatedAt: new Date().toISOString(),
    available: false,
    rows: [],
    total: 0,
    counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
  };
});
