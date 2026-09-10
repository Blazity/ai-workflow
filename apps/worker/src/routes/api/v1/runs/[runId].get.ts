import { defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import type { RunDetailResponse } from "@shared/contracts";
import { requireDashboardActor, toHttpError } from "../../../../services/auth/index.js";
import {
  emptyRunDetail,
  readRunDetail,
} from "../../../../services/run-lifecycle/index.js";

export default defineEventHandler(async (event): Promise<RunDetailResponse> => {
  // no-store: the payload carries the clarification Q&A (answer text plus the
  // responder's identity), which must never be served from a cache. Set before
  // any await so both the live and the durable-fallback responses carry it.
  setResponseHeader(event, "Cache-Control", "private, no-store");

  const generatedAt = new Date().toISOString();
  const runId = getRouterParam(event, "runId");
  if (!runId) return { generatedAt, ...emptyRunDetail() };

  try {
    // Guarded: the detail payload now carries the parked run's clarification Q&A.
    await requireDashboardActor(event);
  } catch (error) {
    toHttpError(error);
  }

  return { generatedAt, ...(await readRunDetail(runId)) };
});
