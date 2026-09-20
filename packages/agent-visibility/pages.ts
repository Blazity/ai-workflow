/**
 * Pages: how a briefing reaches a reader whose results are capped.
 *
 * MCP replaces any result over `MCP_MAX_RESULT_BYTES` with a digest, and MCP
 * clients show a result inline only below roughly 48 KB, so nothing is served
 * whole. A page is measured as what travels: its JSON, where every quote,
 * backslash and newline costs two bytes and a control character six. A page
 * never splits a character, never repeats or skips a byte, and a list page
 * always moves its cursor.
 *
 * The cap given here is for the page object itself. A caller that wraps the
 * page in an envelope of its own passes its cap minus that envelope.
 */
import { z } from "zod";
import {
  AGENT_VISIBILITY_PAGE_DEFAULT_BYTES,
  AGENT_VISIBILITY_PAGE_MAX_BYTES,
  AGENT_VISIBILITY_PAGE_MIN_BYTES,
  AGENT_VISIBILITY_SCHEMA_VERSION,
} from "./limits";
import { byteCountSchema, clampText } from "./primitives";
import { jsonBytes, utf16IndexAtByte, utf8Length, wellFormed } from "./text";

export type AgentVisibilityPageErrorCode =
  | "offset_out_of_range"
  | "offset_inside_character"
  | "section_index_invalid"
  | "cap_out_of_range"
  | "cursor_invalid"
  | "item_too_large";

/** A page request that cannot be served as asked. The message says what would
 *  work instead; a route maps it to a 400. `item_too_large` names the item
 *  and its full size, so a caller can ask again with a cap that holds it. */
export class AgentVisibilityPageError extends Error {
  readonly code: AgentVisibilityPageErrorCode;
  readonly itemIndex: number | null;
  readonly fullBytes: number | null;
  constructor(
    code: AgentVisibilityPageErrorCode,
    message: string,
    item: { index: number; fullBytes: number } | null = null,
  ) {
    super(message);
    this.name = "AgentVisibilityPageError";
    this.code = code;
    this.itemIndex = item?.index ?? null;
    this.fullBytes = item?.fullBytes ?? null;
  }
}

/** One page of one section's stored text. Offsets are UTF-8 bytes of the
 *  stored text; `nextOffset` is null on the last page. */
export const agentBriefingSectionPageSchema = z
  .object({
    schemaVersion: z.literal(AGENT_VISIBILITY_SCHEMA_VERSION),
    sectionIndex: z.number().int().min(0),
    offset: byteCountSchema,
    text: z.string(),
    nextOffset: byteCountSchema.nullable(),
    totalBytes: byteCountSchema,
  })
  .superRefine((page, ctx) => {
    const end = page.offset + utf8Length(page.text);
    const consistent =
      end <= page.totalBytes && (page.nextOffset === null ? end === page.totalBytes : page.nextOffset === end);
    if (!consistent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a page ends where the next begins, and the last page ends at totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type AgentBriefingSectionPage = z.infer<typeof agentBriefingSectionPageSchema>;

/**
 * One page of a list (section headers, a section's parts or spans, the
 * context's repositories, round headers, deliveries, effects). `cursor` is
 * where this page started (null for the first page), `nextCursor` where the
 * next starts (null at the end). An item whose long strings had to be
 * shortened to fit is listed in `shortened` with its full size, so a reader
 * can ask again with a larger cap.
 */
export function agentVisibilityListPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    schemaVersion: z.literal(AGENT_VISIBILITY_SCHEMA_VERSION),
    cursor: z.string().nullable(),
    items: z.array(item),
    shortened: z.array(z.object({ index: byteCountSchema, fullBytes: byteCountSchema })),
    nextCursor: z.string().nullable(),
    total: byteCountSchema,
  });
}
export interface AgentVisibilityListPage<T> {
  schemaVersion: typeof AGENT_VISIBILITY_SCHEMA_VERSION;
  cursor: string | null;
  items: T[];
  shortened: { index: number; fullBytes: number }[];
  nextCursor: string | null;
  total: number;
}

function checkedCap(maxBytes: number | undefined): number {
  const cap = maxBytes ?? AGENT_VISIBILITY_PAGE_DEFAULT_BYTES;
  if (!Number.isInteger(cap) || cap < AGENT_VISIBILITY_PAGE_MIN_BYTES || cap > AGENT_VISIBILITY_PAGE_MAX_BYTES) {
    throw new AgentVisibilityPageError(
      "cap_out_of_range",
      `A page is from ${AGENT_VISIBILITY_PAGE_MIN_BYTES} to ${AGENT_VISIBILITY_PAGE_MAX_BYTES} bytes; ${maxBytes} was asked for.`,
    );
  }
  return cap;
}

/** Bytes one character costs inside a JSON string, as `JSON.stringify` writes
 *  it: two for a quote, a backslash or a short escape, six for any other
 *  control character or a lone surrogate, else its UTF-8 length. */
function jsonCharacterCost(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if ([0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(codePoint)) return 2;
  if (codePoint < 0x20) return 6;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  return codePoint > 0xffff ? 4 : 3;
}

/**
 * The page of `text` (a section's stored text) that starts at `offset`.
 *
 * An offset inside a character is refused rather than snapped: offsets come
 * from `nextOffset`, and snapping a hand-made one would silently repeat or skip
 * bytes. An offset past the end is refused; exactly at the end is an empty last
 * page.
 */
export function pageSectionText(input: {
  sectionIndex: number;
  text: string;
  offset?: number;
  maxBytes?: number;
}): AgentBriefingSectionPage {
  const cap = checkedCap(input.maxBytes);
  if (!Number.isInteger(input.sectionIndex) || input.sectionIndex < 0) {
    throw new AgentVisibilityPageError(
      "section_index_invalid",
      `A section index is a whole number from 0; ${input.sectionIndex} was asked for.`,
    );
  }
  const text = wellFormed(input.text);
  const totalBytes = utf8Length(text);
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > totalBytes) {
    throw new AgentVisibilityPageError(
      "offset_out_of_range",
      `The offset must be a whole number of bytes from 0 to ${totalBytes}; ${offset} is past the end of this ${totalBytes} bytes section or not a whole number.`,
    );
  }
  const start = utf16IndexAtByte(text, offset);
  if (start === null) {
    throw new AgentVisibilityPageError(
      "offset_inside_character",
      `Byte ${offset} falls inside a character. Continue from the nextOffset of the previous page.`,
    );
  }
  const envelope = (pageText: string, nextOffset: number | null): AgentBriefingSectionPage => ({
    schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION,
    sectionIndex: input.sectionIndex,
    offset,
    text: pageText,
    nextOffset,
    totalBytes,
  });
  // The widest envelope this page can have: nextOffset is either a number up
  // to totalBytes or null, and "null" is wider than a number under 1000.
  let room = cap - Math.max(jsonBytes(envelope("", totalBytes)), jsonBytes(envelope("", null)));
  let end = start;
  while (end < text.length) {
    const codePoint = text.codePointAt(end)!;
    const cost = jsonCharacterCost(codePoint);
    if (cost > room) break;
    room -= cost;
    end += codePoint > 0xffff ? 2 : 1;
  }
  const pageText = text.slice(start, end);
  const page = envelope(pageText, end === text.length ? null : offset + utf8Length(pageText));
  if (jsonBytes(page) > cap) {
    throw new Error(`A section page came out at ${jsonBytes(page)} bytes against a cap of ${cap}.`);
  }
  return page;
}

/**
 * Where a byte range of a section (a part range, a redaction span) falls on a
 * page, as string indices into `page.text`, or null when it does not touch the
 * page. A range that starts before the page or ends after it is clipped and
 * says so. A zero-width range belongs to the page it starts on, and one at the
 * very end to the last page.
 */
export function byteRangeInPage(
  page: { offset: number; text: string; nextOffset: number | null },
  range: { start: number; end: number },
): { start: number; end: number; continuesBefore: boolean; continuesAfter: boolean } | null {
  const pageStart = page.offset;
  const pageEnd = page.offset + utf8Length(page.text);
  const touches =
    range.start === range.end
      ? (range.start >= pageStart && range.start < pageEnd) ||
        (range.start === pageEnd && page.nextOffset === null)
      : range.start < pageEnd && range.end > pageStart;
  if (!touches) return null;
  const from = Math.max(range.start, pageStart) - pageStart;
  const to = Math.min(range.end, pageEnd) - pageStart;
  const start = utf16IndexAtByte(page.text, from);
  const end = utf16IndexAtByte(page.text, to);
  if (start === null || end === null) {
    throw new AgentVisibilityPageError(
      "offset_inside_character",
      `The range ${range.start}..${range.end} has an end inside a character of this page.`,
    );
  }
  return {
    start,
    end,
    continuesBefore: range.start < pageStart,
    continuesAfter: range.end > pageEnd,
  };
}

/**
 * A POSITION CURSOR: how far into a list a page reached, and how long that list
 * was when it said so.
 *
 * THE RULE IS THAT A LIST PAGES ON AN APPEND-ONLY KEY, because a position over
 * rows something is still writing serves one entry twice and skips another with
 * nothing red anywhere. A list read out of ONE STORED BRIEFING is the exception:
 * its row is inserted once with `ON CONFLICT DO NOTHING` and never updated, so
 * entry 40 is the same entry on every page of every read of it.
 *
 * The length travels in the cursor so that exception is CHECKED rather than
 * trusted. Hand this pager a list that grew or shrank between two pages and the
 * cursor is refused out loud, exactly as a keyed list refuses a cursor whose
 * entry is gone; the silent double-serve the rule was written against cannot
 * happen here even if a caller one day pages something alive. Both halves mint
 * and read a cursor of this kind here and nowhere else (the worker's
 * `storedListPage` calls the same three functions), so the reader and the
 * writer cannot drift apart.
 */
const POSITION_CURSOR = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Where a page starting at `cursor` begins, or a refusal naming what to do. */
export function positionCursor(cursor: string, length: number): number {
  const parsed = POSITION_CURSOR.exec(cursor);
  const at = parsed === null ? -1 : Number(parsed[1]);
  if (parsed === null || at > length || Number(parsed[2]) !== length) {
    throw new AgentVisibilityPageError(
      "cursor_invalid",
      `The cursor "${cursor}" is not one this list handed out, or the list is no longer the one that handed it out; read the list again from the start.`,
    );
  }
  return at;
}

/** The cursor of the page after one that reached `next`, null at the end. */
export function positionCursorAfter(next: number, length: number): string | null {
  return next < length ? `${next}.${length}` : null;
}

/** The widest cursor a list of this length can hand out, for a caller that has
 *  to reserve room for one before it knows which one it will be. */
export function widestPositionCursor(length: number): string {
  return `${length}.${length}`;
}

/**
 * The page of `items` that starts at `cursor`, as many whole items as fit.
 *
 * Never cuts an array or a join key: an item is served with every entry or
 * not at all. An item that does not fit on an empty page has its long free
 * text shortened (`shortenStrings`) and is listed in `shortened` with its full
 * size, so the cursor always moves; one that does not fit even then is
 * refused with `item_too_large`, naming its full size.
 *
 * ONLY FOR A LIST THAT CANNOT CHANGE BETWEEN TWO READS: see `positionCursor`
 * for what that means and for what happens to a caller that ignores it. A list
 * built from rows something is still writing pages on a key of its own entries
 * and hands this function an already-sliced window with no cursor at all.
 */
export function pageList<T>(
  items: readonly T[],
  options: { cursor?: string | null; maxBytes?: number } = {},
): AgentVisibilityListPage<T> {
  const cap = checkedCap(options.maxBytes);
  const cursor = options.cursor ?? null;
  const start = cursor === null ? 0 : positionCursor(cursor, items.length);
  const page: AgentVisibilityListPage<T> = {
    schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION,
    cursor,
    items: [],
    shortened: [],
    nextCursor: widestPositionCursor(items.length),
    total: items.length,
  };
  // Measured with nextCursor at its widest (the last index, or null), so the
  // final value never grows the page.
  let used = Math.max(jsonBytes(page), jsonBytes({ ...page, nextCursor: null }));
  let next = start;
  while (next < items.length) {
    const item = items[next]!;
    const cost = jsonBytes(item) + (page.items.length > 0 ? 1 : 0);
    if (used + cost <= cap) {
      page.items.push(item);
      used += cost;
      next += 1;
      continue;
    }
    if (page.items.length > 0) break;
    const note = { index: next, fullBytes: jsonBytes(item) };
    const shortened = shortenStrings(item, cap - used - jsonBytes(note));
    if (shortened === null) {
      throw new AgentVisibilityPageError(
        "item_too_large",
        `Item ${next} is ${note.fullBytes} bytes and does not fit a ${cap} bytes page even with its long texts shortened; ask for a larger page.`,
        note,
      );
    }
    page.items.push(shortened);
    page.shortened.push(note);
    next += 1;
    break;
  }
  page.nextCursor = positionCursorAfter(next, items.length);
  if (jsonBytes(page) > cap) {
    throw new Error(`A list page came out at ${jsonBytes(page)} bytes against a cap of ${cap}.`);
  }
  return page;
}

/** Strings at or under this length are never shortened: keys, ids, hashes and
 *  titles are, and a shortened key would not parse. */
const SHORTENABLE_STRING_MIN_LENGTH = 256;
/** Fields that hold join keys, which may be longer (a provenance id is
 *  `promptId:promptName`) and are never shortened at any length: a cut key
 *  joins to the wrong thing or to nothing. An item that fits only by cutting
 *  one is refused with its size instead. */
const JOIN_KEY_FIELDS = new Set([
  "id",
  "key",
  "target",
  "repositoryKey",
  "clarificationId",
  "runId",
  "nodeId",
  "partId",
  "sha256",
  "hash",
]);
/** The shortest a long string is cut to. */
const SHORTENED_STRING_FLOOR = 64;

/**
 * A copy of a JSON value whose long strings are all cut to one common length,
 * each saying its full length, so the copy fits in `maxBytes`; null when even
 * the shortest cut does not fit. Arrays keep every entry and objects every
 * field, so the copy still parses as what it was.
 */
function shortenStrings<T>(value: T, maxBytes: number): T | null {
  const longest = longestString(value);
  if (longest <= SHORTENABLE_STRING_MIN_LENGTH) return null;
  let best: T | null = null;
  let low = SHORTENED_STRING_FLOOR;
  let high = longest - 1;
  while (low <= high) {
    const level = Math.floor((low + high) / 2);
    const candidate = shortenTo(value, level) as T;
    if (jsonBytes(candidate) <= maxBytes) {
      best = candidate;
      low = level + 1;
    } else high = level - 1;
  }
  return best;
}

/** The longest string the shortener may cut. */
function longestString(value: unknown, isKey = false): number {
  if (typeof value === "string") return isKey ? 0 : value.length;
  if (Array.isArray(value)) return value.reduce<number>((most, entry) => Math.max(most, longestString(entry)), 0);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).reduce<number>(
      (most, [key, entry]) => Math.max(most, longestString(entry, JOIN_KEY_FIELDS.has(key))),
      0,
    );
  }
  return 0;
}

function shortenTo(value: unknown, level: number, isKey = false): unknown {
  if (typeof value === "string") {
    return isKey || value.length <= SHORTENABLE_STRING_MIN_LENGTH ? value : clampText(value, level);
  }
  if (Array.isArray(value)) return value.map((entry) => shortenTo(entry, level));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, shortenTo(entry, level, JOIN_KEY_FIELDS.has(key))]),
    );
  }
  return value;
}
