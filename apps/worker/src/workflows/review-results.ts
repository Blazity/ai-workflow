import {
  REVIEW_RESULT_JSON_SCHEMA,
  type ReviewResult,
  type ReviewResultFinding,
} from "@shared/contracts";
import { validateJsonSchemaValue } from "../workflow-definition/json-schema.js";

export type ReviewResultsResolution =
  | { ok: true; value: ReviewResult[] | undefined }
  | { ok: false; message: string };

function normalizedFinding(
  value: Record<string, unknown>,
  resultIndex: number,
  findingIndex: number,
): ReviewResultFinding | string {
  const startLine = value.startLine;
  const endLine = value.endLine;
  const location = `reviewResults[${resultIndex}].findings[${findingIndex}]`;
  if (
    startLine !== undefined &&
    (!Number.isInteger(startLine) || (startLine as number) < 1)
  ) {
    return `${location}.startLine must be a positive integer.`;
  }
  if (
    endLine !== undefined &&
    (!Number.isInteger(endLine) || (endLine as number) < 1)
  ) {
    return `${location}.endLine must be a positive integer.`;
  }
  if (endLine !== undefined && startLine === undefined) {
    return `${location}.endLine requires startLine.`;
  }
  if (
    typeof endLine === "number" &&
    typeof startLine === "number" &&
    endLine < startLine
  ) {
    return `${location}.endLine must be greater than or equal to startLine.`;
  }
  return {
    file: value.file as string,
    description: value.description as string,
    severity: value.severity as ReviewResultFinding["severity"],
    ...(typeof startLine === "number" ? { startLine } : {}),
    ...(typeof endLine === "number" ? { endLine } : {}),
  };
}

export function normalizeReviewResultsInput(
  value: unknown,
): ReviewResultsResolution {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      message: "reviewResults must contain at least one Review Result.",
    };
  }

  const normalized: ReviewResult[] = [];
  for (const [resultIndex, candidate] of value.entries()) {
    const issues = validateJsonSchemaValue(
      REVIEW_RESULT_JSON_SCHEMA,
      candidate,
    );
    if (issues.length > 0) {
      return {
        ok: false,
        message: `reviewResults[${resultIndex}] is invalid: ${issues[0]!.message}`,
      };
    }
    const result = candidate as Record<string, unknown>;
    const findings: ReviewResultFinding[] = [];
    for (const [findingIndex, candidateFinding] of (
      result.findings as unknown[]
    ).entries()) {
      const finding = normalizedFinding(
        candidateFinding as Record<string, unknown>,
        resultIndex,
        findingIndex,
      );
      if (typeof finding === "string") {
        return { ok: false, message: finding };
      }
      findings.push(finding);
    }
    normalized.push({
      decision: result.decision as ReviewResult["decision"],
      findings,
      ...(typeof result.feedback === "string"
        ? { feedback: result.feedback }
        : {}),
    });
  }
  return { ok: true, value: normalized };
}
