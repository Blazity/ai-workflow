import type { WorkflowParamValue } from "@shared/contracts";

export function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function arrayToLines(value: WorkflowParamValue | undefined): string {
  return Array.isArray(value) ? value.join("\n") : "";
}

/**
 * True when `text` still parses to exactly `value`. A line-array param and the textarea
 * the user types it into can only disagree on whitespace the parse drops, so a mismatch
 * means the param was replaced from outside the textarea.
 */
export function textMatchesLines(text: string, value: WorkflowParamValue | undefined): boolean {
  const parsed = linesToArray(text);
  const lines = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return parsed.length === lines.length && parsed.every((line, i) => line === lines[i]);
}
