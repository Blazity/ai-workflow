import type { Finding, Severity } from "./types.js";

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER[s];
}

export function severityAtLeast(a: Severity, threshold: Severity): boolean {
  return severityRank(a) >= severityRank(threshold);
}

export function maxSeverity(findings: readonly Finding[]): Severity | null {
  if (findings.length === 0) return null;
  let max: Severity = "info";
  for (const f of findings) {
    if (severityRank(f.severity) > severityRank(max)) max = f.severity;
  }
  return max;
}

export type CheckRunConclusion =
  | "success"
  | "neutral"
  | "failure"
  | "skipped"
  | "action_required";

/**
 * Map findings to a Check Run conclusion per the spec's rules:
 * - No findings: success
 * - Findings below fail_on: neutral
 * - blocking=false: never failure (use neutral when findings present)
 * - blocking=true and any finding >= fail_on: failure
 * - error path is handled by the caller (see conclusionForError)
 */
export function mapFindingsToConclusion(
  findings: readonly Finding[],
  opts: { blocking: boolean; fail_on: Severity },
): CheckRunConclusion {
  if (findings.length === 0) return "success";
  const top = maxSeverity(findings);
  if (top === null) return "success";
  const meets = severityAtLeast(top, opts.fail_on);
  if (!meets) return "neutral";
  return opts.blocking ? "failure" : "neutral";
}

/**
 * Conclusion for an internal check error.
 * - blocking=true -> failure
 * - blocking=false -> neutral
 */
export function conclusionForError(blocking: boolean): CheckRunConclusion {
  return blocking ? "failure" : "neutral";
}
