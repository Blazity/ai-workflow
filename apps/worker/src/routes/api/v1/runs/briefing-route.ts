/**
 * What every briefing route parses and how every one of them refuses.
 *
 * The handlers above this are transport and nothing else: they resolve who is
 * asking, read the path and the query, and hand both to the one read model the
 * MCP tools also call. A rule that lived here instead would be a rule an agent
 * could not reach.
 */
import { createError, getRouterParam, setResponseHeader, type H3Event } from "h3";

import {
  AGENT_VISIBILITY_PAGE_MAX_BYTES,
  AGENT_VISIBILITY_PAGE_MIN_BYTES,
  AgentVisibilityReadError,
} from "../../../../services/agent-visibility/index.js";
import { toHttpError } from "../../../../services/auth/request-context.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const POSTGRES_INT_MAX = 2_147_483_647;
/** A node id, an activation scope id: what the visibility package accepts as
 *  an id, so a filter cannot name something a briefing could never carry. */
const SAFE_ID_MAX_LENGTH = 200;
/** The same id as the GRAPH spells it, which is what a caller filtering by a
 *  node has in hand. Capture shortens one past 200 characters before storing
 *  it, so refusing the raw spelling here would refuse the only one a caller of
 *  a long-named loop node can give. */
export const FILTER_ID_MAX_LENGTH = 2_000;

/** A briefing is read, never cached: it carries ticket bodies and instruction
 *  files, and the audience is decided per request. */
export function setBriefingNoStore(event: H3Event): void {
  setResponseHeader(event, "Cache-Control", "private, no-store");
}

export function parseRunId(event: H3Event): string {
  const runId = getRouterParam(event, "runId");
  if (!runId || !SAFE_RUN_ID.test(runId)) {
    throw createError({ statusCode: 404, statusMessage: "There is no run by that name." });
  }
  return runId;
}

export function parseBriefingId(event: H3Event): number {
  const raw = getRouterParam(event, "briefingId");
  const briefingId = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(briefingId) || briefingId < 1 || briefingId > POSTGRES_INT_MAX) {
    throw createError({
      statusCode: 404,
      statusMessage: "A briefing id is a whole number a briefing list handed out.",
    });
  }
  return briefingId;
}

export function parseSectionIndex(event: H3Event): number {
  const raw = getRouterParam(event, "sectionIndex");
  const index = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(index) || index < 0 || index > POSTGRES_INT_MAX) {
    throw createError({
      statusCode: 404,
      statusMessage: "A section index is a whole number from 0, as the section headers number them.",
    });
  }
  return index;
}

/** A whole number from a query string, refused rather than clamped: a caller
 *  handed a page it did not ask for cannot tell that from a shorter list. */
export function wholeNumber(
  value: unknown,
  name: string,
  bounds: { min: number; max: number },
): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw createError({
      statusCode: 400,
      statusMessage: `${name} must be a whole number from ${bounds.min} to ${bounds.max}`,
    });
  }
  return parsed;
}

export function textParam(value: unknown, name: string, maxLength = SAFE_ID_MAX_LENGTH): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > maxLength) {
    throw createError({
      statusCode: 400,
      statusMessage: `${name} is at most ${maxLength} characters`,
    });
  }
  return value;
}

/** The two query parameters every paged read takes, parsed once. `limit` is a
 *  byte cap, not a count: what a page holds is decided by what fits. */
export function parseListQuery(query: Record<string, unknown>): {
  cursor?: string;
  limit?: number;
} {
  const cursor = textParam(query.cursor, "cursor", 1_024);
  const limit = wholeNumber(query.limit, "limit", {
    min: AGENT_VISIBILITY_PAGE_MIN_BYTES,
    max: AGENT_VISIBILITY_PAGE_MAX_BYTES,
  });
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** The read model's refusals, as status codes. Each one carries the sentence
 *  the read model wrote, because that sentence is what tells a caller what to
 *  do next. */
export function toBriefingHttpError(error: unknown): never {
  if (error instanceof AgentVisibilityReadError) {
    throw createError({ statusCode: error.statusCode, statusMessage: error.message });
  }
  toHttpError(error);
}
