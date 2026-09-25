/**
 * Where a piece of prompt text came from, so a person reading a recorded
 * prompt can tell our own rules from a ticket comment and a research note from
 * the ticket.
 */
export interface EffectivePromptPartOrigin {
  /** A lowercase slug such as `platform`, `ticket` or `research_note`. Readers
   *  must tolerate a kind they do not know: the worker and the dashboard deploy
   *  separately. */
  kind: string;
  /** The one thing the text is about, where there is one: a ticket key, a
   *  repository, a data reference, a clarification round. */
  ref?: string;
  /** A human qualifier, such as the author of a comment. */
  label?: string;
}

/** Why part of a part's text never reached the agent. */
export type PromptCutCause =
  /** The compiler's 200,000 UTF-16 unit cap on one section. */
  | "section_cap"
  /** The clarification history's own budget (sandbox/context.ts), which drops
   *  the oldest rounds first and shortens the newest when it alone is over. */
  | "clarification_budget";

/**
 * One named piece of a prompt section, in the order it is sent. The parts of a
 * section concatenate to its text, so every byte a model receives belongs to
 * exactly one of them.
 */
export interface EffectivePromptPart {
  /** Unique within its section: a lowercase slug, with an ordinal suffix on a
   *  kind that repeats (`comment:2`). Never derived from user text. */
  id: string;
  title: string;
  content: string;
  origin: EffectivePromptPartOrigin;
  /**
   * Present only on a zero-byte part: a platform rule, or a piece of the
   * ticket, this prompt holds back on purpose, and why, so a reader sees it was
   * left out deliberately rather than forgotten.
   */
  withheld?: { reason: string; text: string };
  /**
   * Set when text of this part was cut before the agent got it: `whole` when
   * none of it was sent (the part is then zero bytes), `partial` when `content`
   * is what was left. Absent when the part was sent whole.
   */
  cutBeforeSend?: "partial" | "whole";
  /** Why it was cut. When two limits cut one part, the first one. */
  cutCause?: PromptCutCause;
  /** The part's length before any cut, in UTF-16 code units, the unit both
   *  limits count in. Set together with `cutBeforeSend`. */
  originalLengthUtf16?: number;
}

export function joinPromptParts(parts: readonly EffectivePromptPart[]): string {
  let text = "";
  for (const part of parts) text += part.content;
  return text;
}

type PromptPiece =
  | EffectivePromptPart
  | readonly EffectivePromptPart[]
  | string
  | null
  | undefined
  | false;

/** A zero-byte part: it records text the agent did not get, a withheld rule
 *  or a part cut whole, and never carries separator text. */
export function recordsUnsentText(part: EffectivePromptPart): boolean {
  return part.withheld !== undefined || part.cutBeforeSend === "whole";
}

/**
 * Compose a section's parts from parts and the literal text between them.
 *
 * A string piece is separator text (a blank line, the newline a template put
 * between two blocks), and so is a part whose content is whitespace only: it
 * names nothing, so it joins the part before it, or the next part when nothing
 * came before. A part that records unsent text (withheld, or cut whole) never
 * takes separator text, so it stays zero bytes. Any other empty part adds
 * nothing and is dropped.
 *
 * Separator text with no part to join is a composition bug, reported by
 * throwing: no part is ever whitespace only.
 */
export function concatPromptParts(
  pieces: readonly PromptPiece[],
): EffectivePromptPart[] {
  const parts: EffectivePromptPart[] = [];
  let pending = "";
  const lastTextPart = (): EffectivePromptPart | undefined => {
    for (let index = parts.length - 1; index >= 0; index--) {
      if (!recordsUnsentText(parts[index]!)) return parts[index];
    }
    return undefined;
  };
  const separator = (text: string) => {
    if (text.length === 0) return;
    const last = lastTextPart();
    if (last) last.content += text;
    else pending += text;
  };
  const add = (part: EffectivePromptPart) => {
    if (recordsUnsentText(part)) {
      parts.push({ ...part, content: "" });
      return;
    }
    if (part.content.trim().length === 0) {
      separator(part.content);
      return;
    }
    parts.push({ ...part, content: pending + part.content });
    pending = "";
  };
  for (const piece of pieces) {
    if (piece === null || piece === undefined || piece === false) continue;
    if (typeof piece === "string") separator(piece);
    else if (isPartList(piece)) piece.forEach(add);
    else add(piece);
  }
  if (pending.length > 0) {
    throw new Error("Prompt separator text has no part to belong to.");
  }
  return parts;
}

function isPartList(
  piece: EffectivePromptPart | readonly EffectivePromptPart[],
): piece is readonly EffectivePromptPart[] {
  return Array.isArray(piece);
}
