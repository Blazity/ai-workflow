const ELISION = " [...] ";
const TAIL_SHARE = 0.6;

/** Cap text while preserving the operation at its head and verdict at its tail. */
export function clampBothEnds(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const budget = maxLength - ELISION.length;
  const tailLength = Math.ceil(budget * TAIL_SHARE);
  const head = text.slice(0, budget - tailLength).trimEnd();
  const tail = text.slice(text.length - tailLength).trimStart();
  return `${head}${ELISION}${tail}`;
}
