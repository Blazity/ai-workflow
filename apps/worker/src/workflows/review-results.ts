import {
  REVIEW_RESULT_JSON_SCHEMA,
  type ReviewResult,
  type ReviewResultFinding,
} from "@shared/contracts";
import { validateJsonSchemaValue } from "../workflow-definition/json-schema.js";

export type ReviewResultsResolution =
  | { ok: true; value: ReviewResult[] | undefined }
  | { ok: false; message: string };

export interface ReviewResultsNormalizationOptions {
  /** Repositories selected for this run, in canonical provider repoPath form. */
  knownRepositories?: readonly string[];
}

export function normalizeFindingRepository(
  value: unknown,
  knownRepositories: readonly string[] = [],
): string | undefined {
  if (typeof value !== "string" || !/^\S+\/\S+$/.test(value)) {
    return undefined;
  }
  return knownRepositories.length === 0 || knownRepositories.includes(value)
    ? value
    : undefined;
}

export function isCrossRepositoryFinding(
  finding: ReviewResultFinding,
  currentRepository: string,
): boolean {
  return finding.repo !== undefined && finding.repo !== currentRepository;
}

function normalizedFinding(
  value: Record<string, unknown>,
  resultIndex: number,
  findingIndex: number,
  options: ReviewResultsNormalizationOptions,
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
  const repo = normalizeFindingRepository(value.repo, options.knownRepositories);
  return {
    file: value.file as string,
    description: value.description as string,
    severity: value.severity as ReviewResultFinding["severity"],
    ...(repo === undefined ? {} : { repo }),
    ...(typeof startLine === "number" ? { startLine } : {}),
    ...(typeof endLine === "number" ? { endLine } : {}),
  };
}

export function normalizeReviewResultsInput(
  value: unknown,
  options: ReviewResultsNormalizationOptions = {},
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
        options,
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
