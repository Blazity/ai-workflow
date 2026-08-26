import type { WorkflowParamValue } from "@shared/contracts";
import {
  REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH,
  REPOSITORY_SCRIPT_GROUP_NAME_PATTERN,
} from "@shared/contracts";

/**
 * Whether `name` is a script group name the server would accept. The shared
 * pattern and bound come from the same module the worker's zod schema uses, so
 * a name the editor lets through can never be one Deploy rejects with a raw
 * zod path.
 */
export function isRepositoryScriptGroupName(name: string): boolean {
  return (
    name.length <= REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH &&
    REPOSITORY_SCRIPT_GROUP_NAME_PATTERN.test(name)
  );
}

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

export function toggleRequiredArrayValue(
  values: string[],
  value: string,
  checked: boolean,
): string[] {
  if (checked) return [...new Set([...values, value])];
  const next = values.filter((entry) => entry !== value);
  return next.length > 0 ? next : values;
}
