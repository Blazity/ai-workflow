/**
 * A section's stored text, as far as its pages are loaded, cut into the parts
 * that make it up and marked where text was redacted.
 *
 * Every size and range in a briefing is in UTF-8 bytes of the stored text; a
 * page's text is a JavaScript string. The package's `byteRangeInPage` is the
 * only thing here that converts between the two. It measures the whole page on
 * every call, which is fine for one range and freezes a phone for a section of
 * 800 parts and 2,000 redactions (800 x 48 KB). So ranges are located in one
 * walk per page: each range, and each gap before it, is handed to
 * `byteRangeInPage` as a window no longer than the range itself (a UTF-16 unit
 * is never shorter than one byte, so a window of N units holds N bytes), and
 * the string index carries over from one range to the next.
 *
 * NOTHING HERE CHANGES THE TEXT. Pieces are slices of the page strings; joined
 * in order they are exactly the loaded stored text.
 */
import {
  byteRangeInPage,
  type AgentBriefingPart,
  type AgentBriefingRedactionSpan,
  type AgentBriefingSectionPage,
} from "@shared/agent-visibility";

export interface LocatedRange {
  start: number;
  end: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * How much text a read handed to `byteRangeInPage`, in UTF-16 units, summed
 * over every call. Divided by a page's length it is the number of times that
 * page was walked: about one per range list here, and one per range if the
 * windows below are ever dropped. Passing this is optional and changes
 * nothing; `section-text.test.ts` holds the walks down with it.
 */
export interface ScanCount {
  units: number;
}

type PageText = Pick<AgentBriefingSectionPage, "offset" | "text" | "nextOffset" | "totalBytes">;

/** The byte at which a page ends: where the next begins, or the section's end. */
export function pageEndByte(page: Pick<AgentBriefingSectionPage, "nextOffset" | "totalBytes">): number {
  return page.nextOffset ?? page.totalBytes;
}

/** UTF-16 units taken by the bytes `[fromByte, toByte)` of `text`, starting at
 *  string index `index`, which sits at `fromByte`. */
function unitsBetween(
  text: string,
  index: number,
  fromByte: number,
  toByte: number,
  scans: ScanCount | undefined,
): number {
  if (toByte === fromByte) return 0;
  const window = text.slice(index, index + (toByte - fromByte));
  if (scans) scans.units += window.length;
  const located = byteRangeInPage(
    { offset: fromByte, text: window, nextOffset: null },
    { start: fromByte, end: toByte },
  );
  if (located === null) {
    throw new Error(`Bytes ${fromByte}..${toByte} are not on this page of the section.`);
  }
  return located.end;
}

/**
 * Where each range falls on `page`, as string indices into `page.text`, or null
 * when it does not touch the page: exactly what `byteRangeInPage` answers for
 * each range, in one walk of the page. `ranges` are ordered by start and do
 * not overlap (a section's parts, its redaction spans); one that breaks the
 * order is located against the whole page instead.
 */
export function locateOnPage(
  page: PageText,
  ranges: readonly { start: number; end: number }[],
  scans?: ScanCount,
): (LocatedRange | null)[] {
  const startByte = page.offset;
  const endByte = pageEndByte(page);
  let cursorByte = startByte;
  let cursorIndex = 0;
  return ranges.map((range) => {
    const touches =
      range.start === range.end
        ? (range.start >= startByte && range.start < endByte) ||
          (range.start === endByte && page.nextOffset === null)
        : range.start < endByte && range.end > startByte;
    if (!touches) return null;
    const from = Math.max(range.start, startByte);
    const to = Math.min(range.end, endByte);
    if (from < cursorByte) {
      if (scans) scans.units += page.text.length;
      return byteRangeInPage(page, range);
    }
    cursorIndex += unitsBetween(page.text, cursorIndex, cursorByte, from, scans);
    const length = unitsBetween(page.text, cursorIndex, from, to, scans);
    const located = {
      start: cursorIndex,
      end: cursorIndex + length,
      continuesBefore: range.start < startByte,
      continuesAfter: range.end > endByte,
    };
    cursorIndex += length;
    cursorByte = to;
    return located;
  });
}

/** A run of stored text: plain, a redaction marker as stored, or the place
 *  where text was removed without a marker. */
export type TextPiece =
  | { kind: "text"; text: string }
  | { kind: "redacted"; text: string; redaction: string }
  | { kind: "removed"; redaction: string };

export interface PartReading {
  part: AgentBriefingPart;
  pieces: TextPiece[];
  /** How much of the part's stored text is on the loaded pages. A part with
   *  no stored text reads `all`. */
  loaded: "all" | "some" | "none";
}

export interface SectionReading {
  parts: PartReading[];
  /** Loaded text past the last loaded part: its part entries have not arrived
   *  yet, so it belongs to nobody we can name. Null when there is none. */
  unattributed: TextPiece[] | null;
  /** Bytes of stored text on the loaded pages, from byte 0. */
  loadedBytes: number;
}

interface LocatedPage {
  page: PageText;
  spans: { located: LocatedRange; kind: string }[];
}

/** The pieces of `[from, to)` of one page, split at the spans inside it.
 *  `closesSection`: a zero-width span at `to` belongs here, because this is
 *  the last text of the section. */
function piecesOf(located: LocatedPage, from: number, to: number, closesSection: boolean): TextPiece[] {
  const pieces: TextPiece[] = [];
  let at = from;
  const text = located.page.text;
  for (const { located: span, kind } of located.spans) {
    if (span.end < from || span.start > to) continue;
    if (span.start === span.end) {
      if (span.start < from || (span.start === to && !closesSection)) continue;
      if (span.start > at) pieces.push({ kind: "text", text: text.slice(at, span.start) });
      at = Math.max(at, span.start);
      pieces.push({ kind: "removed", redaction: kind });
      continue;
    }
    const start = Math.max(span.start, from);
    const end = Math.min(span.end, to);
    if (end <= start) continue;
    if (start > at) pieces.push({ kind: "text", text: text.slice(at, start) });
    pieces.push({ kind: "redacted", text: text.slice(start, end), redaction: kind });
    at = end;
  }
  if (to > at) pieces.push({ kind: "text", text: text.slice(at, to) });
  return pieces;
}

/**
 * The loaded part of a section, part by part.
 *
 * `pages` are consecutive from byte 0; `parts` are the part entries loaded so
 * far, in order (they cover the stored text from byte 0); `spans` the
 * redaction spans loaded so far, in order.
 */
export function readSection(
  pages: readonly PageText[],
  parts: readonly AgentBriefingPart[],
  spans: readonly AgentBriefingRedactionSpan[],
  scans?: ScanCount,
): SectionReading {
  const lastPage = pages.at(-1);
  const loadedBytes = lastPage ? pageEndByte(lastPage) : 0;
  const sectionEnd = pages[0]?.totalBytes ?? 0;
  const located: LocatedPage[] = pages.map((page) => {
    const onPage = locateOnPage(page, spans, scans);
    return {
      page,
      spans: onPage.flatMap((range, position) =>
        range === null ? [] : [{ located: range, kind: spans[position]!.kind }],
      ),
    };
  });
  const partRanges = pages.map((page) => locateOnPage(page, parts.map((part) => part.range), scans));

  const readings: PartReading[] = parts.map((part, position) => {
    const { start, end } = part.range;
    if (start === end) return { part, pieces: [], loaded: start <= loadedBytes ? "all" : "none" };
    const pieces = located.flatMap((page, pageIndex) => {
      const range = partRanges[pageIndex]![position];
      if (!range) return [];
      const closes = end === sectionEnd && pageEndByte(page.page) === sectionEnd;
      return piecesOf(page, range.start, range.end, closes);
    });
    const loaded = end <= loadedBytes ? "all" : start < loadedBytes ? "some" : "none";
    return { part, pieces, loaded };
  });

  const attributedEnd = parts.at(-1)?.range.end ?? 0;
  let unattributed: TextPiece[] | null = null;
  if (attributedEnd < loadedBytes) {
    const rest = { start: attributedEnd, end: loadedBytes };
    unattributed = located.flatMap((page) => {
      const [range] = locateOnPage(page.page, [rest], scans);
      if (!range) return [];
      const closes = loadedBytes === sectionEnd && pageEndByte(page.page) === sectionEnd;
      return piecesOf(page, range.start, range.end, closes);
    });
  }
  return { parts: readings, unattributed, loadedBytes };
}
