/**
 * Applying the injected sanitizer.
 *
 * The sanitizer lives in the worker (it reads configured secrets from the
 * environment); this package only applies what it reports. It reports
 * POSITIONS in the text it was given and the replacement is written here, so
 * everything outside a reported span is byte for byte what the model received.
 * Nothing is found by comparing strings: a Jira comment may legitimately
 * contain a literal `[REDACTED]` that is not a redaction.
 */
import { clampText } from "./primitives";
import { splitsSurrogatePair, utf8Length, wellFormed } from "./text";
import { CONTROL_CHARACTERS_REDACTION_KIND, visibilitySlugSchema } from "./vocabulary";

/**
 * One piece of text the sanitizer wants removed.
 *
 * `start` and `end` are UTF-16 code unit offsets into the text it was given
 * (what `indexOf` and `RegExp.exec` return), half-open. `kind` is an open slug
 * (`AGENT_BRIEFING_REDACTION_KINDS`) and travels in the span, not in the
 * text. `replacement` defaults to `[REDACTED]`; an empty replacement removes
 * the text without a marker, which is how stripped control characters are
 * recorded (`control_characters`, counted per part rather than listed).
 */
export interface VisibilityRedaction {
  start: number;
  end: number;
  kind: string;
  replacement?: string;
}

/**
 * Finds what must not be stored in a text. Called once per section (over the
 * whole text, so a secret split between two parts is still found) and once per
 * free-text field. Must be pure for a given text.
 *
 * ITS DUTY: THE TEXT IT KEEPS IS SERVED UNCHANGED. MCP rewrites every string
 * it serves (`apps/worker/src/mcp/sanitize-result.ts`, `sanitizeString`), and
 * one rewritten byte moves every later byte of a page and breaks every span
 * and part range after it, so the dashboard and MCP would show two texts. So
 * in the text that remains once its reports are applied, the detector reports
 * every span that function would rewrite:
 *
 * - a private key block from `-----BEGIN ... PRIVATE KEY-----` to its END
 *   line, and a header with no END line to the end of the text: MCP reads the
 *   end of the string as the end of the block, and a page can end anywhere in
 *   a section, so on a stored section the block runs to the section's end;
 * - the value after `Authorization: Bearer` (the prefix may stay);
 * - GitHub tokens (`gh` then `p`, `o`, `u`, `s` or `r`, `_`, 36 to 255 letters
 *   and digits);
 * - every configured secret;
 * - control characters (C0 but tab, line feed and carriage return, and DEL),
 *   ANSI sequences with them, as `control_characters` with an empty
 *   replacement. Removing one must not join its neighbours into something the
 *   rules above match (a token with a NUL inside is reported whole).
 *
 * Lone surrogates are not its duty: this package writes each as U+FFFD before
 * the detector sees the text, as the UTF-8 file the model read did. Beyond
 * MCP's rules it reports whatever else must not be stored (the replay
 * sanitizer's classes).
 *
 * Every replacement is itself text MCP leaves unchanged: no control
 * characters, nothing those rules match. `[REDACTED]` passes;
 * `[REDACTED:token]` does not, because after `Authorization: Bearer ` the
 * Bearer rule rewrites it. This is the target stage 3a builds the detector to
 * and stage 4's parity test checks.
 */
export type VisibilitySanitizer = (text: string) => readonly VisibilityRedaction[];

/** What a reported span becomes in the stored text unless the sanitizer says
 *  otherwise. */
export const DEFAULT_REDACTION_REPLACEMENT = "[REDACTED]";

export class AgentVisibilityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentVisibilityInputError";
  }
}

const REPLACEMENT_MAX_LENGTH = 200;
// Control characters and DEL are exactly what the MCP sanitizer strips.
// oxlint-disable-next-line no-control-regex -- the rule is about control characters
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;

export interface AppliedSpan {
  /** UTF-16 offsets in the redacted text. */
  start16: number;
  end16: number;
  /** UTF-8 byte offsets in the redacted text. */
  startByte: number;
  endByte: number;
  kind: string;
}

interface Removal {
  start: number;
  end: number;
  kind: string;
  replacement: string;
}

/**
 * The sanitizer's reports on a well-formed `text`, checked, widened to whole
 * characters and merged: overlapping reports become one removal that keeps the
 * first report's kind and replacement (a token inside a credential URL is one
 * removal, not two).
 */
function removals(text: string, sanitize: VisibilitySanitizer, where: string): Removal[] {
  const checked = [...sanitize(text)].map((span) => {
    const valid =
      Number.isInteger(span.start) &&
      Number.isInteger(span.end) &&
      span.start >= 0 &&
      span.start < span.end &&
      span.end <= text.length &&
      visibilitySlugSchema.safeParse(span.kind).success &&
      (span.replacement === undefined ||
        (typeof span.replacement === "string" &&
          span.replacement.length <= REPLACEMENT_MAX_LENGTH &&
          !CONTROL_CHARACTER.test(span.replacement)));
    if (!valid) {
      throw new AgentVisibilityInputError(
        `The sanitizer reported an unusable redaction in ${where}: ${span.start}..${span.end} of kind "${span.kind}" in a text of ${text.length} characters. A redaction is a non-empty range inside the text with a slug kind and a replacement of at most ${REPLACEMENT_MAX_LENGTH} characters without control characters.`,
      );
    }
    return {
      start: splitsSurrogatePair(text, span.start) ? span.start - 1 : span.start,
      end: splitsSurrogatePair(text, span.end) ? span.end + 1 : span.end,
      kind: span.kind,
      replacement: wellFormed(span.replacement ?? DEFAULT_REDACTION_REPLACEMENT),
    };
  });
  checked.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Removal[] = [];
  for (const span of checked) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/** Writes `removals` (sorted, apart, inside `text`) into `text`. */
function apply(text: string, list: readonly Removal[]): { text: string; spans: AppliedSpan[] } {
  let out = "";
  let byte = 0;
  let cursor = 0;
  const spans: AppliedSpan[] = [];
  for (const removal of list) {
    const kept = text.slice(cursor, removal.start);
    out += kept;
    byte += utf8Length(kept);
    const start16 = out.length;
    const startByte = byte;
    out += removal.replacement;
    byte += utf8Length(removal.replacement);
    spans.push({ start16, end16: out.length, startByte, endByte: byte, kind: removal.kind });
    cursor = removal.end;
  }
  return { text: out + text.slice(cursor), spans };
}

export interface RedactedPart {
  text: string;
  /** Spans in this part's redacted text, control characters excluded. */
  spans: AppliedSpan[];
  controlCharactersStripped: number;
}

/**
 * Redacts a section whose parts are `lengths` UTF-16 units long, in order.
 *
 * The sanitizer sees the whole section, so a secret the composer happened to
 * split between two parts is still found. A removal that crosses a part
 * boundary is split into one span per part: the first piece carries the
 * replacement, the rest remove their text without a marker, so the secret
 * reads as one `[REDACTED]` where it started.
 */
export function redactSection(
  text: string,
  lengths: readonly number[],
  sanitize: VisibilitySanitizer,
  where: string,
): RedactedPart[] {
  const found = removals(text, sanitize, where);
  const bounds: number[] = [0];
  for (const length of lengths) bounds.push(bounds.at(-1)! + length);
  return lengths.map((_length, position) => {
    const from = bounds[position]!;
    const to = bounds[position + 1]!;
    const local = found.flatMap((removal) => {
      const start = Math.max(removal.start, from);
      const end = Math.min(removal.end, to);
      if (start >= end) return [];
      return [
        {
          start: start - from,
          end: end - from,
          kind: removal.kind,
          replacement: start === removal.start ? removal.replacement : "",
        },
      ];
    });
    const applied = apply(text.slice(from, to), local);
    const control = applied.spans.filter((span) => span.kind === CONTROL_CHARACTERS_REDACTION_KIND);
    return {
      text: applied.text,
      spans: applied.spans.filter((span) => span.kind !== CONTROL_CHARACTERS_REDACTION_KIND),
      controlCharactersStripped: control.length,
    };
  });
}

/** A free-text field after the sanitizer: its text and where the markers
 *  are, so a later clamp never cuts one in half. */
export interface SanitizedText {
  text: string;
  spans: readonly AppliedSpan[];
}

/**
 * A free-text field (a title, a label, a description) after the sanitizer.
 * Counts its redactions, stripped control characters apart. A field the
 * sanitizer empties entirely reads as the marker, so a required field is never
 * blank and a reader sees that something was there.
 */
export function sanitizeText(
  value: string,
  sanitize: VisibilitySanitizer,
  where: string,
  counter: { redactions: number },
): SanitizedText {
  const text = wellFormed(value);
  const applied = apply(text, removals(text, sanitize, where));
  counter.redactions += applied.spans.filter((span) => span.kind !== CONTROL_CHARACTERS_REDACTION_KIND).length;
  if (applied.text.length === 0 && text.length > 0) {
    const end = DEFAULT_REDACTION_REPLACEMENT.length;
    return {
      text: DEFAULT_REDACTION_REPLACEMENT,
      spans: [{ start16: 0, end16: end, startByte: 0, endByte: end, kind: applied.spans[0]!.kind }],
    };
  }
  return applied;
}

/** A sanitized field cut to `maxLength`, saying so, never inside a marker. */
export function clampSanitized(field: SanitizedText, maxLength: number): string {
  return clampText(field.text, maxLength, field.spans);
}
