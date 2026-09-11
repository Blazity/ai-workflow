import type { RunAnalysisReport } from "@shared/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validRepository(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    ["github", "gitlab"].includes(String(value.provider)) &&
    typeof value.repoPath === "string" &&
    typeof value.defaultBranch === "string" &&
    typeof value.researchBranch === "string" &&
    isNullableString(value.researchBaseSha) &&
    ["read", "write"].includes(String(value.access)) &&
    typeof value.rationale === "string"
  );
}

function validRepositoryRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    ["github", "gitlab"].includes(String(value.provider)) &&
    typeof value.repoPath === "string" &&
    typeof value.rationale === "string"
  );
}

function validPhaseUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const tokens = value.tokens;
  return (
    (value.costUsd === null || isFiniteNumber(value.costUsd)) &&
    (tokens === null || (
      isRecord(tokens) &&
      isFiniteNumber(tokens.input) &&
      isFiniteNumber(tokens.cachedInput) &&
      isFiniteNumber(tokens.output)
    )) &&
    isFiniteNumber(value.durationMs) &&
    isFiniteNumber(value.numTurns) &&
    isNullableString(value.model)
  );
}

function validUsage(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.phases)) return false;
  return (
    typeof value.capturedAt === "string" &&
    isFiniteNumber(value.costUsd) &&
    typeof value.costKnown === "boolean" &&
    (value.tokensInput === null || isFiniteNumber(value.tokensInput)) &&
    (value.tokensCached === null || isFiniteNumber(value.tokensCached)) &&
    (value.tokensOutput === null || isFiniteNumber(value.tokensOutput)) &&
    Object.values(value.phases).every(validPhaseUsage)
  );
}

function validDelivery(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    ["not_applicable", "pending", "posted", "failed"].includes(String(value.state)) &&
    isNullableString(value.attemptedAt) &&
    isNullableString(value.commentUrl) &&
    isNullableString(value.error)
  );
}

function validPullRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    ["github", "gitlab"].includes(String(value.provider)) &&
    typeof value.repoPath === "string" &&
    isFiniteNumber(value.id) &&
    typeof value.url === "string" &&
    (value.headSha === undefined || typeof value.headSha === "string")
  );
}

function validPublication(value: unknown): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    Array.isArray(value.prs) &&
    value.prs.every(validPullRequest) &&
    typeof value.changeSummary === "string"
  );
}

function validSanitization(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.redactions)) return false;
  return (
    Object.values(value.redactions).every(isFiniteNumber) &&
    typeof value.truncated === "boolean" &&
    isFiniteNumber(value.originalBytes) &&
    isFiniteNumber(value.storedBytes) &&
    typeof value.unavailable === "boolean" &&
    [null, "serialization", "traversal_limit", "size_limit"].includes(
      value.unavailableReason as null | string,
    )
  );
}

/** Validate the JSON shape stored in workflow_runs.analysis_report. */
export function parseStoredRunAnalysisReport(value: unknown): RunAnalysisReport | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    typeof value.runId !== "string" ||
    typeof value.sourceResearchRunId !== "string" ||
    !isFiniteNumber(value.researchRevision) ||
    !Number.isInteger(value.researchRevision) ||
    value.researchRevision < 1 ||
    !["research_complete", "published", "no_change"].includes(String(value.stage)) ||
    typeof value.researchCompletedAt !== "string" ||
    !Array.isArray(value.repositories) ||
    !value.repositories.every(validRepository) ||
    !isFiniteNumber(value.expansionRounds) ||
    !Array.isArray(value.repositoryRequests) ||
    !value.repositoryRequests.every(validRepositoryRequest) ||
    !Array.isArray(value.writeRepositories) ||
    !value.writeRepositories.every(validRepositoryRequest) ||
    !["captured", "not_retained"].includes(String(value.evidenceStatus)) ||
    !isStringArray(value.evidence) ||
    typeof value.planMarkdown !== "string" ||
    typeof value.noChangeNeeded !== "boolean" ||
    !isStringArray(value.resolutionEvidence) ||
    !validPublication(value.publication) ||
    !isRecord(value.usage) ||
    !isRecord(value.jira) ||
    !validSanitization(value.sanitization)
  ) return null;
  const usage = value.usage as Record<string, unknown>;
  const jira = value.jira as Record<string, unknown>;
  if (!validDelivery(jira.research) || !validDelivery(jira.pullRequest)) return null;
  if (!validUsage(usage.research)) return null;
  if (usage.publication !== null && !validUsage(usage.publication)) return null;
  if (usage.final !== null && !validUsage(usage.final)) return null;
  return value as unknown as RunAnalysisReport;
}
