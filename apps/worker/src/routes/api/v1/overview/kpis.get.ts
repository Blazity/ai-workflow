import { defineEventHandler, setResponseHeader } from "h3";
import type { KpisResponse } from "@shared/contracts";

export default defineEventHandler((event): KpisResponse => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );
  return {
    generatedAt: new Date().toISOString(),
    runs24h: null,
    p95: null,
    errors24h: null,
    cost24h: null,
  };
});
