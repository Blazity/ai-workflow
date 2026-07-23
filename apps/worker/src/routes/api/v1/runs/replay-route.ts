import {
  createError,
  getRouterParam,
  setResponseHeader,
  type H3Event,
} from "h3";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const POSTGRES_INT_MAX = 2_147_483_647;

export function setReplayNoStore(event: H3Event): void {
  setResponseHeader(event, "Cache-Control", "private, no-store");
}

export function parseReplayRunId(event: H3Event): string {
  const runId = getRouterParam(event, "runId");
  if (!runId || !SAFE_RUN_ID.test(runId)) {
    throw createError({ statusCode: 404, statusMessage: "Replay not found" });
  }
  return runId;
}

export function parseReplayAttemptId(event: H3Event): number {
  const raw = getRouterParam(event, "attemptId");
  const attemptId = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(attemptId) ||
    attemptId < 1 ||
    attemptId > POSTGRES_INT_MAX
  ) {
    throw createError({ statusCode: 404, statusMessage: "Attempt not found" });
  }
  return attemptId;
}
