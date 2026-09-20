/**
 * UTF-8 arithmetic over JavaScript strings.
 *
 * Every size and range in a stored record is in UTF-8 bytes of the text as the
 * model received it: the prompt is written into the sandbox as a UTF-8 file, so
 * that is what the model read, and it is what a person copying bytes out of a
 * page can check. JavaScript indexes strings in UTF-16 code units, so the two
 * are converted here and nowhere else.
 */

const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;
const LOW_SURROGATE_MIN = 0xdc00;

/** The character starting at `index`: its code point (a lone surrogate
 *  reads as itself), how many UTF-16 units it takes and how many UTF-8 bytes
 *  it is written as, a lone surrogate counting as the U+FFFD it becomes. */
function characterAt(text: string, index: number): { codePoint: number; units: number; bytes: number } {
  const codePoint = text.codePointAt(index)!;
  if (codePoint > 0xffff) return { codePoint, units: 2, bytes: 4 };
  if (codePoint < 0x80) return { codePoint, units: 1, bytes: 1 };
  if (codePoint < 0x800) return { codePoint, units: 1, bytes: 2 };
  return { codePoint, units: 1, bytes: 3 };
}

const isLoneSurrogate = (codePoint: number) => codePoint >= SURROGATE_MIN && codePoint <= SURROGATE_MAX;

/**
 * The text with every lone surrogate replaced by U+FFFD.
 *
 * The compiler cuts a section at a UTF-16 index, which can split a surrogate
 * pair; UTF-8 cannot encode the half that is left, and the encoder writing the
 * prompt file turns it into U+FFFD. So this is the text the model received, and
 * it keeps the UTF-16 length, which keeps part boundaries where they were.
 */
export function wellFormed(text: string): string {
  let out = "";
  let segmentStart = 0;
  for (let index = 0; index < text.length; ) {
    const character = characterAt(text, index);
    if (isLoneSurrogate(character.codePoint)) {
      out += `${text.slice(segmentStart, index)}\uFFFD`;
      segmentStart = index + 1;
    }
    index += character.units;
  }
  return segmentStart === 0 ? text : out + text.slice(segmentStart);
}

/** True when a UTF-16 index falls between the two halves of a surrogate pair. */
export function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const here = text.codePointAt(index)!;
  return here >= LOW_SURROGATE_MIN && here <= SURROGATE_MAX && text.codePointAt(index - 1)! > 0xffff;
}

/** UTF-8 bytes of `text.slice(from, to)`, lone surrogates counted as U+FFFD. */
export function utf8Length(text: string, from = 0, to = text.length): number {
  let total = 0;
  for (let index = from; index < to; ) {
    const character = characterAt(text, index);
    // A pair that `to` splits counts as the lone half it leaves.
    if (character.units === 2 && index + 1 >= to) {
      total += 3;
      break;
    }
    total += character.bytes;
    index += character.units;
  }
  return total;
}

/**
 * The UTF-16 index at which `bytes` UTF-8 bytes of `text` end, or null when
 * that byte offset falls inside a character.
 */
export function utf16IndexAtByte(text: string, bytes: number): number | null {
  let total = 0;
  let index = 0;
  while (total < bytes && index < text.length) {
    const character = characterAt(text, index);
    total += character.bytes;
    index += character.units;
  }
  return total === bytes ? index : null;
}

/**
 * The largest UTF-16 index whose prefix fits in `maxBytes` UTF-8 bytes without
 * splitting a character.
 */
export function utf16IndexWithinBytes(text: string, maxBytes: number): number {
  let total = 0;
  let index = 0;
  while (index < text.length) {
    const character = characterAt(text, index);
    if (total + character.bytes > maxBytes) break;
    total += character.bytes;
    index += character.units;
  }
  return index;
}

/** UTF-8 bytes of `value` as JSON: what a stored record or a page weighs. */
export function jsonBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value));
}

const encoder = new TextEncoder();

/** Lower-case hex sha256 of the UTF-8 encoding, the spelling the compiler uses
 *  for its own section hashes. `crypto.subtle` exists in Node and in browsers,
 *  so this stays free of Node-only modules. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
