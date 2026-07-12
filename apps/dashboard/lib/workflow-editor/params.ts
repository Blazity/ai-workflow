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
