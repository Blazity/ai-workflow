const ELISION = " [...] ";
const TAIL_SHARE = 0.6;

/** Where a sentence ends: its closing punctuation, any quote or bracket that
 *  closes with it, then the space before the next one. */
const SENTENCE_END = /[.!?]["')]*(?=\s)/g;
/** Where the next sentence starts: after that space, on a letter, digit, quote
 *  or opening bracket. A "[" is not one, so a marker an earlier clamp left is
 *  never taken for the start of a sentence. */
const SENTENCE_START = /[.!?]["')]*\s+(?=[\p{L}\p{N}"'(`])/gu;

/**
 * Cap text while preserving the operation at its head and verdict at its tail.
 *
 * WHERE IT CUTS is what decides whether a person can read what is left. It
 * used to cut at a character count, so a sentence a person was meant to act on
 * reached the ticket as "the agent sti [...] epository list" (production,
 * 2026-09-18). Each end is still given its share of the budget, and within that
 * share the cut falls, in order of preference:
 *
 * 1. between sentences, when a sentence boundary keeps at least half of that
 *    end's share;
 * 2. between words, when a word boundary does;
 * 3. through a character, only for a single token longer than half the share
 *    (a URL, a hash), which no boundary can save.
 *
 * The shares stay fixed on purpose. Letting a whole opening sentence borrow
 * from the tail reads better for prose and loses the verdict of raw output,
 * which is what the tail share exists to keep: the HTTP status at the end of a
 * git failure, and the diagnostic ID at the end of a composed message.
 */
export function clampBothEnds(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const budget = maxLength - ELISION.length;
  // The tail first, so what its boundary gives back goes to the head. Neither
  // end keeps a marker an earlier clamp left at its edge, or the two would sit
  // side by side and say nothing twice.
  const tail = keptEnd(text, Math.ceil(budget * TAIL_SHARE)).replace(/^\[\.\.\.\]\s*/, "");
  const head = keptStart(text, budget - tail.length).replace(/\s*\[\.\.\.\]$/, "");
  return `${head}${ELISION}${tail}`;
}

/** At most the first `length` characters, ending where a sentence or a word
 *  ends. */
function keptStart(text: string, length: number): string {
  const window = text.slice(0, length);
  const least = length / 2;
  // One character past the window, so a sentence ending exactly at its edge is
  // seen to be followed by a space.
  let sentenceEnd = -1;
  for (const match of text.slice(0, length + 1).matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (end <= length && end >= least) sentenceEnd = end;
  }
  if (sentenceEnd > 0) return window.slice(0, sentenceEnd);
  if (/\s/.test(text[length] ?? " ")) return window.trimEnd();
  const wordEnd = window.search(/\s\S*$/);
  return wordEnd >= least ? window.slice(0, wordEnd).trimEnd() : window.trimEnd();
}

/** At most the last `length` characters, starting where a sentence or a word
 *  starts. */
function keptEnd(text: string, length: number): string {
  const start = text.length - length;
  const window = text.slice(start);
  const most = start + length / 2;
  for (const match of text.matchAll(SENTENCE_START)) {
    const next = match.index + match[0].length;
    if (next > most) break;
    if (next >= start) return text.slice(next);
  }
  if (/\s/.test(text[start - 1] ?? " ")) return window.trimStart();
  const wordStart = window.search(/\s/);
  return wordStart >= 0 && start + wordStart <= most
    ? window.slice(wordStart).trimStart()
    : window.trimStart();
}
