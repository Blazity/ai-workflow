import type { Check } from "./types.js";

// Implementations are wired in later milestones (M6 complexity, M7 ai_review).
// The registry is intentionally empty for now — the workflow executor must
// dispatch through registry lookup, NOT by branching on kind strings.
export const CHECKS: Record<string, Check> = {};

export function registerCheck(check: Check): void {
  if (CHECKS[check.kind]) {
    throw new Error(`Check kind already registered: ${check.kind}`);
  }
  CHECKS[check.kind] = check;
}

export function getCheck(kind: string): Check | undefined {
  return CHECKS[kind];
}
