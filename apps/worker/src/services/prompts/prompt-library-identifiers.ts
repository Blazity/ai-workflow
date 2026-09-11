/**
 * Which prompt ids and version numbers the library can hold at all.
 *
 * The id and version columns are int4, and a value past that range overflows
 * the query into a 500 instead of the clean miss the caller expects, so the
 * bound is a rule about the stored data and is decided here rather than in
 * whichever transport happened to receive the number.
 */

/** Largest value an int4 column stores. */
export const MAX_PROMPT_INT4 = 2147483647;

/** Whether a number could name a stored prompt row. */
export function isStorablePromptId(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_PROMPT_INT4;
}

/** Whether a number could name a stored version of a prompt. Versions start at 1. */
export function isStorablePromptVersion(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PROMPT_INT4;
}
