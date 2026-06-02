import { defineEventHandler, setResponseHeader } from "h3";
import type { EvalHealthResponse } from "@shared/contracts";

export default defineEventHandler((event): EvalHealthResponse => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );
  return { available: false, reason: "Eval grading not wired up yet." };
});
