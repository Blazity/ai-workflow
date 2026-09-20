/**
 * What a paged read of a briefing or a round answers with, and how it refuses.
 *
 * ONE ENVELOPE FOR BOTH READERS. The dashboard and MCP call the same functions
 * and serve the same object, so a screen can never show something a terminal
 * cannot; the only difference is how a refusal reaches the caller, which is a
 * status code on one side and an error code on the other, and what each one
 * asks for by default.
 *
 * TWO KINDS OF LIST, AND THEY PAGE DIFFERENTLY.
 * - A list read out of ONE STORED BRIEFING (its sections, a section's parts and
 *   spans, the repository context's repositories, the unresolved sources) is
 *   immutable: the row is written once with `ON CONFLICT DO NOTHING` and never
 *   updated, so a position is a stable cursor and `total` is exact and free.
 * - A list built from ROWS A LIVE RUN IS STILL WRITING (the Block Attempts of a
 *   run, the rounds of a subject) is not. A position there serves one entry
 *   twice and skips another the moment something is inserted between two pages,
 *   with nothing red anywhere, so those page on a key of the entry itself and
 *   refuse a cursor the list did not hand out.
 */
import { Buffer } from "node:buffer";

import {
  AgentVisibilityPageError,
  AGENT_VISIBILITY_PAGE_DEFAULT_BYTES,
  AGENT_VISIBILITY_PAGE_MAX_BYTES,
  AGENT_VISIBILITY_PAGE_MIN_BYTES,
  pageList,
  type AgentVisibilityListPage,
  type VisibilityRead,
} from "@shared/agent-visibility";

export {
  AGENT_VISIBILITY_PAGE_DEFAULT_BYTES,
  AGENT_VISIBILITY_PAGE_MAX_BYTES,
  AGENT_VISIBILITY_PAGE_MIN_BYTES,
};

/**
 * A stored row a reader could not read, named rather than dropped.
 *
 * Same four fields as the package's `ClarificationRoundSkip`, because it is the
 * same fact about a different table: which collection, where in it, which
 * record, and what was wrong with it. `problem` names fields and never quotes
 * the row, so a refusal can be shown to whoever may read the list.
 */
export interface AgentVisibilityUnreadable {
  /** The collection the entry came from, and the base `position` counts in. */
  rows: string;
  /** Its index in the collection `rows` names. NOT an index into `items`:
   *  `shortened[].index` is that, and the two are different bases on purpose,
   *  because a shortened entry IS on this page and an unreadable one is not. */
  position: number;
  id: string | null;
  problem: string;
}

/**
 * How many unreadable entries one page carries, and how much of each.
 *
 * A schema version this build does not know makes EVERY briefing of every new
 * run unreadable while the worker and the dashboard deploy separately, which is
 * the case the plan planned for. Unbounded, that list reserved so much of a page
 * that no item fit at all and the read answered a refusal: measured at 140
 * entries against the MCP default and 320 against HTTP. So the page carries a
 * few, says how many there are in `unreadableTotal`, and can no longer be the
 * reason a page cannot be served.
 */
export const AGENT_VISIBILITY_UNREADABLE_PER_PAGE = 5;
const UNREADABLE_PROBLEM_MAX_LENGTH = 200;

function clampUnreadable(entry: AgentVisibilityUnreadable): AgentVisibilityUnreadable {
  return entry.problem.length <= UNREADABLE_PROBLEM_MAX_LENGTH
    ? entry
    : { ...entry, problem: `${entry.problem.slice(0, UNREADABLE_PROBLEM_MAX_LENGTH - 1)}…` };
}

/**
 * The package's list page, plus the entries that never reached it.
 *
 * `unreadable` is always present, empty when everything read. An entry there is
 * an entry that is NOT in `items` and is not counted by `total` either: the
 * screen says "one entry of this list could not be read" instead of quietly
 * showing one fewer.
 */
export type AgentVisibilityPage<T> = AgentVisibilityListPage<T> & {
  unreadable: AgentVisibilityUnreadable[];
  /** Every entry this query could not read, whether or not it is listed above. */
  unreadableTotal: number;
};

/** A read that cannot be served as asked. `statusCode` is what the route
 *  answers; `mcpCode` is what the tool answers, so one refusal has one meaning
 *  on both surfaces. */
export class AgentVisibilityReadError extends Error {
  readonly statusCode: number;
  readonly mcpCode: "NOT_FOUND" | "VALIDATION_FAILED" | "FORBIDDEN" | "INTERNAL_ERROR";
  constructor(
    statusCode: number,
    mcpCode: "NOT_FOUND" | "VALIDATION_FAILED" | "FORBIDDEN" | "INTERNAL_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "AgentVisibilityReadError";
    this.statusCode = statusCode;
    this.mcpCode = mcpCode;
  }
}

export function notFound(message: string): AgentVisibilityReadError {
  return new AgentVisibilityReadError(404, "NOT_FOUND", message);
}

export function badRequest(message: string): AgentVisibilityReadError {
  return new AgentVisibilityReadError(400, "VALIDATION_FAILED", message);
}

/** We cannot work out who may read this, so nobody does. Never a 404, which
 *  would read as "there is nothing here". */
export function cannotConfirmAudience(message: string): AgentVisibilityReadError {
  return new AgentVisibilityReadError(403, "FORBIDDEN", message);
}

/**
 * A page the store could not assemble although the briefing is there.
 *
 * Its own outcome, never a missing briefing: "we kept this send and cannot show
 * it" and "this send was never recorded" send a person to two different places.
 */
export function storageFault(message: string): AgentVisibilityReadError {
  return new AgentVisibilityReadError(500, "INTERNAL_ERROR", message);
}

/** Runs `work` and re-raises the package's own page refusal as this layer's.
 *  Everything the package refuses is the caller's to correct. */
export function paging<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof AgentVisibilityPageError) throw badRequest(error.message);
    throw error;
  }
}

/**
 * The byte cap for one page, as a caller asked for it.
 *
 * Refused rather than clamped, exactly as the work scope route refuses a page
 * number it will not serve: a caller handed a smaller page than it asked for
 * cannot tell that from a shorter list. `maximum` is the surface's own ceiling,
 * which is the package's on HTTP and a smaller, measured one over MCP.
 */
/** What HTTP serves: the package's own numbers, because neither of the two
 *  reasons MCP needs smaller ones applies to a plain response body. */
export const HTTP_PAGE_BOUNDS = {
  default: AGENT_VISIBILITY_PAGE_DEFAULT_BYTES,
  maximum: AGENT_VISIBILITY_PAGE_MAX_BYTES,
} as const;

export function pageLimit(
  value: number | undefined,
  bounds: { default: number; maximum: number } = HTTP_PAGE_BOUNDS,
): number {
  if (value === undefined) return bounds.default;
  if (!Number.isInteger(value) || value < AGENT_VISIBILITY_PAGE_MIN_BYTES || value > bounds.maximum) {
    throw badRequest(
      `limit is a whole number of bytes from ${AGENT_VISIBILITY_PAGE_MIN_BYTES} to ${bounds.maximum}; ${value} was asked for.`,
    );
  }
  return value;
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/**
 * A copy with every key whose value is `undefined` removed.
 *
 * `JSON.stringify` drops such a key and MCP's serve-time sanitizer turns it
 * into `null`, so the same record would reach the dashboard without the field
 * and reach an agent with a null the frozen schemas refuse. Dropped here, once,
 * before either surface sees it.
 */
export function dropUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropUndefined) as unknown as T;
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== undefined) kept[key] = dropUndefined(entry);
  }
  return kept as T;
}

/** A record the package refused, as an `unreadable` entry. */
export function unreadableOf(
  rows: string,
  position: number,
  id: string | null,
  read: Extract<VisibilityRead<unknown>, { ok: false }>,
): AgentVisibilityUnreadable {
  return { rows, position, id, problem: read.message };
}

interface AssembleInput<T> {
  /** The window to serve, in serving order, starting at `cursor`. */
  window: readonly T[];
  /** Where this page starts, as the caller named it. */
  cursor: string | null;
  /** Where the page after this one starts, given how many items fit: null when
   *  the window ran out. */
  nextCursorOf: (served: number) => string | null;
  /** How many entries this list can serve for this query, not for this window. */
  total: number;
  limit: number;
  /** Every entry this query could not read. What the page carries is at most
   *  `AGENT_VISIBILITY_UNREADABLE_PER_PAGE` of them, chosen once the window is
   *  known where the caller can say which belong to it. */
  unreadable: AgentVisibilityUnreadable[];
  /** Which of them belong to the items actually served. Absent means all of
   *  them do, which is true of a list whose entries are its own rows. */
  unreadableFor?: (served: readonly T[]) => AgentVisibilityUnreadable[];
  /** Fields this page carries beyond the package's, reserved for by name. */
  extra?: Record<string, unknown>;
  /** The widest a cursor of this list can be, so the page still fits once the
   *  package's numeric placeholder is replaced by a real one. */
  widestCursorBytes: number;
}

/** The bytes the served `unreadable` cannot exceed: the widest clamped entry
 *  this query has, as many times as a page will carry. An upper bound rather
 *  than the real cost, because which entries are served is not known until the
 *  window is, and a reserve that guessed low would turn into a 500. */
function unreadableReserve(entries: readonly AgentVisibilityUnreadable[]): number {
  if (entries.length === 0) return jsonBytes([]);
  const widest = entries.reduce((most, entry) => Math.max(most, jsonBytes(clampUnreadable(entry))), 0);
  return jsonBytes([]) + Math.min(entries.length, AGENT_VISIBILITY_UNREADABLE_PER_PAGE) * (widest + 1);
}

/**
 * One page, measured as what travels.
 *
 * The package decides how many whole items fit and shortens the one that does
 * not, and this function only tells it how much room the fields it does not
 * know about have already taken: the cursors this list really hands out, the
 * `unreadable` entries it will carry, and whatever a particular list adds
 * beside them.
 */
function assemble<T>(input: AssembleInput<T>): AgentVisibilityPage<T> {
  const extra = input.extra ?? {};
  const reserved =
    jsonBytes(input.cursor) +
    input.widestCursorBytes +
    unreadableReserve(input.unreadable) +
    jsonBytes(extra) +
    // The names of the fields reserved for above and the commas joining them,
    // rather than a round number: an underestimate here becomes a 500.
    jsonBytes(["cursor", "nextCursor", "unreadable", "unreadableTotal", ...Object.keys(extra)]) +
    Object.keys(extra).length +
    8;
  const room = input.limit - reserved;
  if (room < AGENT_VISIBILITY_PAGE_MIN_BYTES) {
    throw badRequest(
      `A page of this list needs ${reserved + AGENT_VISIBILITY_PAGE_MIN_BYTES} bytes before its first entry, because of the length of its cursors; ${input.limit} was asked for.`,
    );
  }
  const page = paging(() => pageList(input.window, { cursor: null, maxBytes: room }));
  const mine = input.unreadableFor?.(page.items) ?? input.unreadable;
  const assembled: AgentVisibilityPage<T> = {
    ...page,
    ...extra,
    cursor: input.cursor,
    nextCursor: input.nextCursorOf(page.items.length),
    total: input.total,
    unreadable: mine.slice(0, AGENT_VISIBILITY_UNREADABLE_PER_PAGE).map(clampUnreadable),
    unreadableTotal: input.unreadable.length,
  };
  const size = jsonBytes(assembled);
  if (size > input.limit) {
    throw new Error(`A page came out at ${size} bytes against a limit of ${input.limit}.`);
  }
  return assembled;
}

/**
 * One page of a list read out of one stored briefing.
 *
 * The cursor is a position because the source cannot change: a briefing row is
 * inserted once and never updated, so entry 40 is the same entry on every page
 * of every read of it.
 */
export function storedListPage<T>(
  items: readonly T[],
  options: {
    cursor?: string | null;
    limit: number;
    unreadable?: AgentVisibilityUnreadable[];
    extra?: Record<string, unknown>;
  },
): AgentVisibilityPage<T> {
  const cursor = options.cursor ?? null;
  const from = cursor === null ? 0 : positionCursor(cursor, items.length);
  return assemble({
    window: items.slice(from),
    cursor,
    nextCursorOf: (served) => (from + served < items.length ? String(from + served) : null),
    total: items.length,
    limit: options.limit,
    unreadable: options.unreadable ?? [],
    ...(options.extra === undefined ? {} : { extra: options.extra }),
    widestCursorBytes: jsonBytes(String(items.length)),
  });
}

const POSITION_CURSOR = /^(?:0|[1-9][0-9]*)$/;

function positionCursor(cursor: string, length: number): number {
  if (!POSITION_CURSOR.test(cursor) || Number(cursor) > length) {
    throw badRequest(`The cursor "${cursor}" is not one this list handed out; start again without a cursor.`);
  }
  return Number(cursor);
}

/**
 * One page of a list built from rows something is still writing.
 *
 * The cursor names the LAST ENTRY SERVED rather than a position, so a row
 * inserted between two pages cannot make the next page repeat an entry or skip
 * one. A cursor whose entry is no longer in the list is refused: it is the only
 * honest answer once the ground under a page has moved.
 */
export function keyedListPage<T>(
  items: readonly T[],
  options: {
    keyOf: (item: T) => string;
    cursor?: string | null;
    limit: number;
    /** How many entries this query can serve; the window's length unless the
     *  caller knows better. */
    total?: number;
    unreadable?: AgentVisibilityUnreadable[];
    unreadableFor?: (served: readonly T[]) => AgentVisibilityUnreadable[];
    extra?: Record<string, unknown>;
  },
): AgentVisibilityPage<T> {
  const cursor = options.cursor ?? null;
  let from = 0;
  if (cursor !== null) {
    const at = items.findIndex((item) => options.keyOf(item) === cursor);
    if (at === -1) {
      throw badRequest(
        `The cursor "${cursor}" names an entry this list no longer has, so the page after it cannot be found. Read the list again from the start.`,
      );
    }
    from = at + 1;
  }
  const window = items.slice(from);
  const widest = window.reduce((most, item) => Math.max(most, jsonBytes(options.keyOf(item))), 2);
  return assemble({
    window,
    cursor,
    nextCursorOf: (served) =>
      served > 0 && from + served < items.length ? options.keyOf(window[served - 1]!) : null,
    total: options.total ?? items.length,
    limit: options.limit,
    unreadable: options.unreadable ?? [],
    ...(options.unreadableFor === undefined ? {} : { unreadableFor: options.unreadableFor }),
    ...(options.extra === undefined ? {} : { extra: options.extra }),
    widestCursorBytes: widest,
  });
}
