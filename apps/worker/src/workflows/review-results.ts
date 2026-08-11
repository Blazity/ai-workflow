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

/**
 * Resolve an agent-authored repository path against the run's selected
 * repositories, and answer with the selected repository's own spelling.
 *
 * The match is case-insensitive because a forge path is: the value is prose an
 * agent copied from a ticket, and tickets spell `blazity/ai-workflow-prod` where
 * the run carries `Blazity/ai-workflow-prod`. An exact comparison read that as
 * an unknown repository and failed the whole run.
 *
 * Answering with the known spelling rather than the agent's is what makes the
 * result usable downstream: cross-repository attribution compares this value
 * against the review target's repoPath, so echoing the agent's casing would mark
 * a finding about the reviewed repository as belonging to another one.
 */
export function normalizeFindingRepository(
  value: unknown,
  knownRepositories: readonly string[] = [],
): string | undefined {
  if (typeof value !== "string" || !/^\S+\/\S+$/.test(value)) {
    return undefined;
  }
  if (knownRepositories.length === 0) return value;
  const wanted = value.toLowerCase();
  return knownRepositories.find(
    (repository) => repository.toLowerCase() === wanted,
  );
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
  if (value.repo !== undefined && repo === undefined) {
    return `${location}.repo must identify a repository selected for this run.`;
  }
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
