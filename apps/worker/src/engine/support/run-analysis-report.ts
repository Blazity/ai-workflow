import type {
  RunAnalysisCommentDelivery,
  RunAnalysisLeftOutRepository,
  RunAnalysisPhaseUsage,
  RunAnalysisReport,
  RunAnalysisRepository,
  RunAnalysisRepositoryRequest,
  RunAnalysisUsageSnapshot,
  RunPullRequest,
  ReplaySanitizationMetadata,
} from "@shared/contracts";
import { parseStoredRunAnalysisReport } from "../../db/repositories/runs/analysis-report.js";

export { parseStoredRunAnalysisReport };
import type { PhaseUsage } from "../../sandbox/agents/types.js";
import type { PriceLookup, UsageTotals } from "../../sandbox/usage.js";
import { configuredReplaySecrets } from "../../run-observability/configured-secrets.js";
import { sanitizeReplayValue } from "../../run-observability/sanitizer.js";
import { scrubForPublication } from "../../infra/publication-scrub.js";

const REPORT_MAX_BYTES = 64 * 1024;
const COMMENT_MAX_BYTES = 20_000;
const OMITTED = "… omitted; open the full run report";

type Provider = "github" | "gitlab";

interface ManifestRepository {
  provider: Provider;
  repoPath: string;
  defaultBranch?: string;
  branchName?: string;
  researchBranch?: string;
  researchBaseSha?: string | null;
  access?: "read" | "write";
  selectedRationale?: string;
  rationale?: string;
}

interface AnalysisInputBase {
  runId: string;
  sourceResearchRunId?: string;
  researchRevision?: number;
  researchCompletedAt?: string;
  capturedAt?: string;
  workspaceManifest?: { repositories?: ManifestRepository[] } | null;
  manifest?: { repositories?: ManifestRepository[] } | null;
  repositories?: ManifestRepository[];
  selectedRepositories?: Array<{
    provider: Provider;
    repoPath: string;
    selectedRationale?: string;
    rationale?: string;
    defaultBranch?: string;
  }>;
  repositoryExpansion?: {
    rounds?: number;
    priorRequests?: Array<RunAnalysisRepositoryRequest>;
  };
  expansionRounds?: number;
  repositoryRequests?: RunAnalysisRepositoryRequest[];
  writeRepositories?: RunAnalysisRepositoryRequest[];
  /** Repositories the run was asked to work on and did not, decided where the
   *  decision was made (repository discovery) and carried down, because nothing
   *  further along can tell a repository that was left out from one the model
   *  never proposed. */
  leftOutRepositories?: RunAnalysisLeftOutRepository[];
  /** What a person can do about the repositories above. Composed from the work
   *  scope record by the caller, because only the caller knows whether a person
   *  excluded a repository or the catalog never offered it. */
  repositoryRecoveryNotes?: string[];
  researchResult?: {
    body?: string;
    plan?: string;
    repositoryEvidence?: string[];
    resolutionEvidence?: string[];
    noChangeNeeded?: boolean;
    repositories?: RunAnalysisRepositoryRequest[];
    writeRepositories?: RunAnalysisRepositoryRequest[];
  };
  result?: AnalysisInputBase["researchResult"];
  research?: AnalysisInputBase["researchResult"];
  usage?: RunAnalysisUsageSnapshot | UsageTotals;
  researchUsage?: RunAnalysisUsageSnapshot | UsageTotals;
  researchTotals?: UsageTotals;
  noChangeNeededOverride?: boolean;
  phaseUsages?: Record<string, PhaseUsage | null>;
  phaseModels?: Record<string, string>;
  priceLookup?: PriceLookup;
  model?: string;
  jiraApplicable?: boolean;
}

export interface BuildResearchAnalysisReportInput extends AnalysisInputBase {}

export interface BuildApprovedPlanAnalysisReportInput {
  runId: string;
  sourceRunId?: string | null;
  sourceReport?: unknown | null;
  report?: unknown | null;
  approvedPlan: {
    markdown: string;
    sourceRunId?: string;
    repositoryScope?: {
      repositories: Array<{
        provider: Provider;
        repoPath: string;
        defaultBranch: string;
        researchBranch: string;
        researchBaseSha: string;
        access: "read" | "write";
        rationale: string;
      }>;
    };
  };
  capturedAt?: string;
}

function nowIso(value?: string): string {
  return value ?? new Date().toISOString();
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function safeModelText(value: unknown): string {
  if (typeof value !== "string") return "";
  // The replay sanitizer handles credentials and token-shaped values. These
  // explicit markers are not credentials, but are private implementation
  // paths/session bookkeeping that must never enter the report surface.
  return scrubForPublication(value
    .replace(/\b(?:ai-workflow|blazebot)\/memory\/[^\s)`\]]+/gi, "[omitted memory path]")
    .replace(/(?:\/vercel\/sandbox|\/tmp\/attachments|\/workspace\/)[^\s)`]*/gi, "[omitted private path]")
    .replace(/\b(?:session|memory)[_-][A-Za-z0-9-]+\b/gi, "[omitted session reference]")
    .replace(/\bsession\s+memory(?:\s+(?:text|document|bookkeeping))?\b/gi, "[omitted session reference]"));
}

function safeModelList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map(safeModelText)
    .filter((value) => value.trim().length > 0)
    .slice(0, 50);
}

function limitUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(value) <= maxBytes) return value;
  const marker = `\n${OMITTED}`;
  if (utf8Bytes(marker) >= maxBytes) return sliceUtf8(OMITTED, maxBytes, "head");
  const budget = Math.max(0, maxBytes - utf8Bytes(marker));
  return `${sliceUtf8(value, budget, "head")}${marker}`;
}

function boundModelList(values: string[], maxBytes: number): string[] {
  const output: string[] = [];
  let used = 2;
  for (const value of values) {
    const item = limitUtf8(value, 1_200);
    const next = used + utf8Bytes(item) + 1;
    if (next > maxBytes) {
      output.push(OMITTED);
      break;
    }
    output.push(item);
    used = next;
  }
  return output;
}

function safeRequestList(values: unknown): RunAnalysisRepositoryRequest[] {
  if (!Array.isArray(values)) return [];
  const requests = values
    .filter((value): value is Record<string, unknown> => !!value && typeof value === "object")
    .map((value): RunAnalysisRepositoryRequest => ({
      provider: value.provider === "gitlab" ? "gitlab" : "github",
      repoPath: typeof value.repoPath === "string" ? limitUtf8(safeModelText(value.repoPath), 512) : "unknown",
      rationale: limitUtf8(safeModelText(value.rationale), 1_200),
    }))
    .filter((value) => value.repoPath !== "unknown" && value.rationale.length > 0)
    .slice(0, 8);
  let used = 2;
  const bounded: RunAnalysisRepositoryRequest[] = [];
  for (const request of requests) {
    const next = used + utf8Bytes(JSON.stringify(request)) + 1;
    if (next > 8 * 1024) break;
    bounded.push(request);
    used = next;
  }
  return bounded;
}

function matchingRationale(
  repo: ManifestRepository,
  selected: BuildResearchAnalysisReportInput["selectedRepositories"],
): string {
  const match = selected?.find(
    (candidate) => candidate.provider === repo.provider && candidate.repoPath === repo.repoPath,
  );
  return safeModelText(
    repo.selectedRationale ?? repo.rationale ?? match?.selectedRationale ?? match?.rationale ?? "Selected by the workflow planner.",
  );
}

function mapRepositories(input: BuildResearchAnalysisReportInput): RunAnalysisRepository[] {
  const manifest = input.workspaceManifest ?? input.manifest;
  const repos = manifest?.repositories ?? input.repositories ?? [];
  return repos
    .filter((repo): repo is ManifestRepository => !!repo && typeof repo.repoPath === "string")
    .map((repo) => ({
      provider: repo.provider === "gitlab" ? "gitlab" : "github",
      repoPath: repo.repoPath,
      defaultBranch: repo.defaultBranch ?? "unknown",
      researchBranch: repo.researchBranch ?? repo.branchName ?? repo.defaultBranch ?? "unknown",
      researchBaseSha: typeof repo.researchBaseSha === "string" ? repo.researchBaseSha : null,
      access: repo.access === "read" ? "read" : "write",
      rationale: matchingRationale(repo, input.selectedRepositories),
    }));
}

function aggregateMetadata(
  first: ReplaySanitizationMetadata,
  second: ReplaySanitizationMetadata,
): ReplaySanitizationMetadata {
  const redactions = { ...first.redactions };
  for (const [key, count] of Object.entries(second.redactions)) {
    redactions[key as keyof typeof redactions] =
      (redactions[key as keyof typeof redactions] ?? 0) + (count ?? 0);
  }
  return {
    redactions,
    truncated: first.truncated || second.truncated,
    originalBytes: first.originalBytes + second.originalBytes,
    storedBytes: first.storedBytes + second.storedBytes,
    unavailable: first.unavailable || second.unavailable,
    unavailableReason: first.unavailableReason ?? second.unavailableReason,
  };
}

function sanitizeBundle(bundle: Record<string, unknown>): {
  value: Record<string, unknown>;
  metadata: ReplaySanitizationMetadata;
} {
  const envelope = sanitizeReplayValue(bundle, {
    secrets: configuredReplaySecrets(),
    maxBytes: REPORT_MAX_BYTES,
  });
  if (
    envelope.metadata.unavailable ||
    envelope.value === null ||
    typeof envelope.value !== "object" ||
    Array.isArray(envelope.value)
  ) {
    throw new Error("run analysis report content could not be safely retained");
  }
  return { value: envelope.value as Record<string, unknown>, metadata: envelope.metadata };
}

function phaseUsage(value: unknown): RunAnalysisPhaseUsage | null {
  if (!value || typeof value !== "object") return null;
  const phase = value as Record<string, unknown>;
  const tokens = phase.tokens;
  return {
    costUsd: typeof phase.costUsd === "number" ? phase.costUsd : null,
    tokens:
      tokens && typeof tokens === "object"
        ? {
            input: Number((tokens as Record<string, unknown>).input) || 0,
            cachedInput: Number((tokens as Record<string, unknown>).cachedInput ?? (tokens as Record<string, unknown>).cached_input) || 0,
            output: Number((tokens as Record<string, unknown>).output) || 0,
          }
        : null,
    durationMs: Number(phase.durationMs ?? phase.duration_ms) || 0,
    numTurns: Number(phase.numTurns ?? phase.num_turns) || 0,
    model: typeof phase.model === "string" ? phase.model : null,
  };
}

/** Convert worker usage totals into the public report snapshot without making
 * unknown tokens/cost look like zero. */
export function usageSnapshot(
  totals: UsageTotals | RunAnalysisUsageSnapshot,
  capturedAt: string,
): RunAnalysisUsageSnapshot {
  if ("capturedAt" in totals && "costKnown" in totals) {
    return {
      capturedAt,
      costUsd: totals.costUsd,
      costKnown: totals.costKnown,
      tokensInput: totals.tokensInput,
      tokensCached: totals.tokensCached,
      tokensOutput: totals.tokensOutput,
      phases: Object.fromEntries(
        Object.entries(totals.phases ?? {}).map(([name, value]) => [name, phaseUsage(value) ?? {
          costUsd: null,
          tokens: null,
          durationMs: 0,
          numTurns: 0,
          model: null,
        }]),
      ),
    };
  }
  return {
    capturedAt,
    costUsd: Number(totals.costUsd) || 0,
    costKnown: totals.costKnown !== false,
    tokensInput: totals.tokensInput ?? null,
    tokensCached: totals.tokensCached ?? null,
    tokensOutput: totals.tokensOutput ?? null,
    phases: Object.fromEntries(
      Object.entries(totals.phases ?? {}).map(([name, value]) => [name, phaseUsage(value) ?? {
        costUsd: null,
        tokens: null,
        durationMs: 0,
        numTurns: 0,
        model: null,
      }]),
    ),
  };
}

function fallbackUsage(input: BuildResearchAnalysisReportInput, capturedAt: string): RunAnalysisUsageSnapshot {
  if (input.researchTotals) return usageSnapshot(input.researchTotals, capturedAt);
  if (input.researchUsage && "costUsd" in input.researchUsage) {
    return usageSnapshot(input.researchUsage, capturedAt);
  }
  if (input.usage && "costUsd" in input.usage) {
    return usageSnapshot(input.usage, capturedAt);
  }
  if (input.phaseUsages) {
    // Importing computeUsageTotals here would make this pure module depend on a
    // workflow singleton. The worker passes totals in production; this fallback
    // keeps tests and older callers honest, with unknown phases retained.
    const phases = Object.fromEntries(
      Object.entries(input.phaseUsages).map(([name, value]) => [name, value ? {
        costUsd: value.cost_usd,
        tokens: value.tokens ? {
          input: value.tokens.input,
          cachedInput: value.tokens.cached_input,
          output: value.tokens.output,
        } : null,
        durationMs: value.duration_ms,
        numTurns: value.num_turns,
        model: input.phaseModels?.[name] ?? input.model ?? null,
      } : {
        costUsd: null,
        tokens: null,
        durationMs: 0,
        numTurns: 0,
        model: input.phaseModels?.[name] ?? input.model ?? null,
      }]),
    );
    const values = Object.values(phases) as Array<RunAnalysisPhaseUsage>;
    const known = values.every((value) => value.costUsd !== null);
    return {
      capturedAt,
      costUsd: values.reduce((sum, value) => sum + (value.costUsd ?? 0), 0),
      costKnown: known,
      tokensInput: values.every((value) => value.tokens !== null) ? values.reduce((sum, value) => sum + (value.tokens?.input ?? 0), 0) : null,
      tokensCached: values.every((value) => value.tokens !== null) ? values.reduce((sum, value) => sum + (value.tokens?.cachedInput ?? 0), 0) : null,
      tokensOutput: values.every((value) => value.tokens !== null) ? values.reduce((sum, value) => sum + (value.tokens?.output ?? 0), 0) : null,
      phases: phases as Record<string, RunAnalysisPhaseUsage>,
    };
  }
  return {
    capturedAt,
    costUsd: 0,
    costKnown: false,
    tokensInput: null,
    tokensCached: null,
    tokensOutput: null,
    phases: {},
  };
}

function emptyDelivery(state: RunAnalysisCommentDelivery["state"] = "pending"): RunAnalysisCommentDelivery {
  return { state, attemptedAt: null, commentUrl: null, error: null };
}

export function buildResearchAnalysisReport(input: BuildResearchAnalysisReportInput): RunAnalysisReport {
  const result = input.researchResult ?? input.result ?? input.research ?? {};
  const noChangeNeeded = input.noChangeNeededOverride ?? result.noChangeNeeded === true;
  const capturedAt = nowIso(input.capturedAt);
  const plan = limitUtf8(safeModelText(result.body ?? result.plan ?? ""), 16 * 1024);
  const requests = safeRequestList(
    input.repositoryRequests ?? input.repositoryExpansion?.priorRequests ?? result.repositories,
  );
  const writes = safeRequestList(input.writeRepositories ?? result.writeRepositories);
  const evidence = boundModelList(safeModelList(result.repositoryEvidence), 18 * 1024);
  const resolutionEvidence = boundModelList(safeModelList(result.resolutionEvidence), 6 * 1024);
  const sourceRepositories = mapRepositories(input);
  const sanitized = sanitizeBundle({
    planMarkdown: plan,
    evidence,
    resolutionEvidence,
    repositoryRequests: requests,
    writeRepositories: writes,
    rationales: sourceRepositories.map((repo) => limitUtf8(repo.rationale, 768)).slice(0, 8),
  });
  const value = sanitized.value;
  const usage = fallbackUsage(input, capturedAt);
  const repositories = sourceRepositories.map((repository, index) => Object.assign({}, repository, {
    rationale:
      Array.isArray(value.rationales) && typeof value.rationales[index] === "string"
        ? value.rationales[index] as string
        : "Selection rationale was not retained.",
  }));
  const leftOut = safeLeftOutRepositories(input.leftOutRepositories);
  const leftOutOmitted = leftOutRepositoriesOmitted(input.leftOutRepositories, leftOut.length);
  const recoveryNotes = safeRecoveryNotes(input.repositoryRecoveryNotes);
  return {
    version: 1,
    runId: input.runId,
    sourceResearchRunId: input.sourceResearchRunId ?? input.runId,
    researchRevision:
      Number.isInteger(input.researchRevision) && Number(input.researchRevision) > 0
        ? Number(input.researchRevision)
        : 1,
    stage: noChangeNeeded ? "no_change" : "research_complete",
    researchCompletedAt: input.researchCompletedAt ?? capturedAt,
    repositories,
    // Absent rather than empty when the run left nothing out, so a report says
    // nothing instead of saying "left out: none".
    ...(leftOut.length > 0 ? { leftOutRepositories: leftOut } : {}),
    // Only alongside a repository they are about. A recovery sentence with no
    // left-out line above it answers a question the reader was never asked.
    ...(leftOutOmitted > 0 ? { leftOutRepositoriesOmitted: leftOutOmitted } : {}),
    ...(leftOut.length > 0 && recoveryNotes.length > 0
      ? { repositoryRecoveryNotes: recoveryNotes }
      : {}),
    expansionRounds: input.expansionRounds ?? input.repositoryExpansion?.rounds ?? 0,
    repositoryRequests: (value.repositoryRequests as RunAnalysisRepositoryRequest[]) ?? requests,
    writeRepositories: (value.writeRepositories as RunAnalysisRepositoryRequest[]) ?? writes,
    evidenceStatus: "captured",
    evidence: (value.evidence as string[]) ?? evidence,
    planMarkdown: typeof value.planMarkdown === "string" ? value.planMarkdown : plan,
    noChangeNeeded,
    resolutionEvidence: (value.resolutionEvidence as string[]) ?? resolutionEvidence,
    publication: null,
    usage: { research: usage, publication: null, final: null },
    jira: {
      research: emptyDelivery(input.jiraApplicable === false ? "not_applicable" : "pending"),
      pullRequest: emptyDelivery("not_applicable"),
    },
    sanitization: sanitized.metadata,
  };
}

function scopeRepositories(scope: BuildApprovedPlanAnalysisReportInput["approvedPlan"]["repositoryScope"]): RunAnalysisRepository[] {
  return (scope?.repositories ?? []).map((repo) => ({
    provider: repo.provider,
    repoPath: repo.repoPath,
    defaultBranch: repo.defaultBranch,
    researchBranch: repo.researchBranch,
    researchBaseSha: repo.researchBaseSha ?? null,
    access: repo.access,
    rationale: limitUtf8(safeModelText(repo.rationale), 1_200),
  }));
}

export function buildApprovedPlanAnalysisReport(input: BuildApprovedPlanAnalysisReportInput): RunAnalysisReport {
  const source = parseStoredRunAnalysisReport(input.sourceReport ?? input.report);
  if (source) {
    return {
      ...source,
      runId: input.runId,
      sourceResearchRunId: source.sourceResearchRunId || source.runId,
      publication: null,
      usage: { ...source.usage, publication: null, final: null },
      jira: { research: source.jira.research, pullRequest: emptyDelivery("not_applicable") },
    };
  }
  const capturedAt = nowIso(input.capturedAt);
  const sourceScope = scopeRepositories(input.approvedPlan.repositoryScope);
  const approvedMarkdown = limitUtf8(safeModelText(input.approvedPlan.markdown), 24 * 1024);
  const sanitized = sanitizeBundle({
    planMarkdown: approvedMarkdown,
    rationales: sourceScope.map((repository) => repository.rationale),
  });
  const scope = sourceScope.map((repository, index) => Object.assign({}, repository, {
    rationale:
      Array.isArray(sanitized.value.rationales) &&
      typeof sanitized.value.rationales[index] === "string"
        ? sanitized.value.rationales[index] as string
        : "Selection rationale was not retained.",
  }));
  return {
    version: 1,
    runId: input.runId,
    sourceResearchRunId: input.sourceRunId ?? input.approvedPlan.sourceRunId ?? input.runId,
    researchRevision: 1,
    stage: "research_complete",
    researchCompletedAt: capturedAt,
    repositories: scope,
    expansionRounds: 0,
    repositoryRequests: [],
    writeRepositories: scope.filter((repo) => repo.access === "write").map(({ provider, repoPath, rationale }) => ({ provider, repoPath, rationale })),
    evidenceStatus: "not_retained",
    evidence: [],
    planMarkdown: typeof sanitized.value.planMarkdown === "string" ? sanitized.value.planMarkdown : approvedMarkdown,
    noChangeNeeded: false,
    resolutionEvidence: [],
    publication: null,
    usage: { research: usageSnapshot({ costUsd: 0, costKnown: false, tokensInput: null, tokensCached: null, tokensOutput: null, phases: {} }, capturedAt), publication: null, final: null },
    jira: { research: emptyDelivery("not_applicable"), pullRequest: emptyDelivery("not_applicable") },
    sanitization: sanitized.metadata,
  };
}

export function withAnalysisPublication(
  report: RunAnalysisReport,
  publication: { prs: RunPullRequest[] } | RunPullRequest[],
  changeSummary: string,
  usage: RunAnalysisUsageSnapshot | UsageTotals,
): RunAnalysisReport {
  const prs = Array.isArray(publication) ? publication : publication.prs;
  const safeSummary = safeModelText(changeSummary);
  const existingAgentBundle = {
    planMarkdown: report.planMarkdown,
    evidence: report.evidence,
    resolutionEvidence: report.resolutionEvidence,
    repositoryRequests: report.repositoryRequests,
    writeRepositories: report.writeRepositories,
    rationales: report.repositories.map((repository) => repository.rationale),
  };
  const summaryEnvelope = sanitizeReplayValue(safeSummary, {
    secrets: configuredReplaySecrets(),
    // Leave enough room for JSON escaping (including control characters) and
    // sanitizer metadata before the publication bundle applies its exact
    // combined-byte bound.
    maxBytes: Math.max(REPORT_MAX_BYTES, utf8Bytes(safeSummary) * 8 + 4 * 1024),
  });
  if (
    summaryEnvelope.metadata.unavailable ||
    typeof summaryEnvelope.value !== "string"
  ) {
    throw new Error("run analysis publication summary could not be safely retained");
  }
  const sanitizedSummary = summaryEnvelope.value;
  const authoredBundle = (summary: string): Record<string, unknown> => ({
    ...existingAgentBundle,
    changeSummary: summary,
  });
  const bundleBytes = (summary: string): number =>
    utf8Bytes(JSON.stringify(authoredBundle(summary)));
  let nextSummary = sanitizedSummary;
  let summaryTruncated = summaryEnvelope.metadata.truncated;
  if (bundleBytes(nextSummary) > REPORT_MAX_BYTES) {
    const omissionMarker = `\n${OMITTED}`;
    const markerOnly = omissionMarker;
    if (bundleBytes(markerOnly) <= REPORT_MAX_BYTES) {
      let low = 0;
      let high = utf8Bytes(sanitizedSummary);
      let best = markerOnly;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = `${sliceUtf8(sanitizedSummary, middle, "head")}${omissionMarker}`;
        if (bundleBytes(candidate) <= REPORT_MAX_BYTES) {
          best = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      nextSummary = best;
    } else if (bundleBytes("") <= REPORT_MAX_BYTES) {
      nextSummary = "";
    } else {
      throw new Error("run analysis publication bundle exceeds its storage bound");
    }
    summaryTruncated = true;
  }
  const summaryMetadata: ReplaySanitizationMetadata = {
    ...summaryEnvelope.metadata,
    truncated: summaryTruncated,
    storedBytes: utf8Bytes(JSON.stringify(nextSummary)),
  };
  return {
    ...report,
    stage: "published",
    publication: {
      prs: prs.map((pr) => ({
        provider: pr.provider,
        repoPath: pr.repoPath,
        id: pr.id,
        url: pr.url,
      })),
      changeSummary: nextSummary,
    },
    usage: { ...report.usage, publication: usageSnapshot(usage, nowIso()) },
    sanitization: aggregateMetadata(report.sanitization, summaryMetadata),
  };
}

export function withAnalysisDelivery(
  report: RunAnalysisReport,
  stage: "research_complete" | "published" | "no_change" | "research" | "pull_request",
  delivery: RunAnalysisCommentDelivery,
): RunAnalysisReport {
  const slot = stage === "published" || stage === "pull_request" ? "pullRequest" : "research";
  return { ...report, jira: { ...report.jira, [slot]: { ...delivery } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function analysisCommentMarker(runId: string, stage: "research" | "pull_request"): string {
  return `Arthur report: ${runId}:${stage}`;
}

export function hasAnalysisComment(ticket: unknown, marker: string): boolean {
  const comments = isRecord(ticket) && Array.isArray(ticket.comments) ? ticket.comments : Array.isArray(ticket) ? ticket : [];
  return comments.some((comment) => {
    const body = typeof comment === "string"
      ? comment
      : isRecord(comment) && typeof comment.body === "string"
        ? comment.body
        : "";
    return body.split(/\r?\n/u).some((line) => line.trim() === marker);
  });
}

function costLabel(snapshot: RunAnalysisUsageSnapshot): string {
  return `$${snapshot.costUsd.toFixed(2)}${snapshot.costKnown ? "" : "+"}`;
}

function usageLines(snapshot: RunAnalysisUsageSnapshot): string[] {
  const tokens = snapshot.tokensInput === null ? "tokens unknown" : `${snapshot.tokensInput} in / ${snapshot.tokensOutput ?? 0} out`;
  const phaseLines = Object.entries(snapshot.phases).map(([name, phase]) =>
    `- ${name}: ${costLabel({ ...snapshot, costUsd: phase.costUsd ?? 0, costKnown: phase.costUsd !== null })} · ${phase.durationMs}ms · ${phase.model ?? "model unknown"}`,
  );
  return [`Total: ${costLabel(snapshot)} · ${tokens}`, ...phaseLines];
}

/**
 * The repositories section of the comment: the ones the run worked on, then the
 * ones it was asked to work on and did not.
 *
 * One section rather than two, because a repository that was left out is not a
 * new subject, it is a repository in a state, and this is the section a reader
 * already opens to find out which repositories a run touched. Split across two
 * places, the person who excluded a repository in March reads an ordinary
 * success comment in May, finds a pull request short one repository, and has
 * nowhere to learn that their own decision is why.
 */
function repositoryLines(report: RunAnalysisReport): string[] {
  const worked = report.repositories.length > 0
    ? report.repositories.map((repo) => `- ${repo.provider}:${repo.repoPath} · ${repo.access} · ${repo.researchBranch}@${repo.researchBaseSha ? repo.researchBaseSha.slice(0, 8) : "unknown SHA"} · ${repo.rationale}`)
    : ["- No repository manifest was retained."];
  return [
    ...worked,
    ...(report.leftOutRepositories ?? []).map(
      (repository) => `- ${repository.repositoryKey} · left out · ${repository.reason}`,
    ),
    // The bound, said out loud. Eight lines and ten lines look identical to a
    // reader, so a list that was cut says so rather than letting the reader
    // take its last line for the last repository.
    ...(report.leftOutRepositoriesOmitted
      ? [
          `- and ${report.leftOutRepositoriesOmitted} more, not listed here; open the full run report`,
        ]
      : []),
    // Unbulleted and last, because they are not repositories: they are what the
    // reader can do about the lines above, and a person who excluded a
    // repository months ago is reading this comment precisely because the run
    // came back short. This is the only surface that reaches them on a run that
    // finished, so the sentence lives or dies here.
    ...(report.repositoryRecoveryNotes ?? []),
  ];
}

/**
 * The left-out repositories as the report may store them.
 *
 * Bounded the way the rationales beside them are: the list comes from a model's
 * proposal, and the report has a storage bound and the comment a byte cap that
 * this section is not trimmed by. The sentences are OURS, composed from the
 * record rather than from model text, so they are length-limited rather than
 * sanitized as untrusted text would be.
 */
function safeLeftOutRepositories(
  value: RunAnalysisLeftOutRepository[] | undefined,
): RunAnalysisLeftOutRepository[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (repository) =>
        typeof repository?.repositoryKey === "string" && typeof repository?.reason === "string",
    )
    .slice(0, 8)
    .map((repository) => ({
      repositoryKey: limitUtf8(repository.repositoryKey, 256),
      reason: limitUtf8(repository.reason, 512),
    }));
}

/**
 * The recovery sentences as the report may store them.
 *
 * Bounded like the left-out list beside it, and for the same reason: the report
 * has a storage bound and this section is not among the ones the comment
 * trimmer shortens. Two is the most the composer can produce (the exclusion can
 * be taken back, and the catalog cannot serve it today), so a longer list means
 * a caller that has started repeating itself.
 */
function safeRecoveryNotes(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((note) => typeof note === "string" && note.trim().length > 0)
    .slice(0, 2)
    .map((note) => limitUtf8(note, 512));
}

/** How many of the caller's left-out repositories the bound above dropped.
 *
 *  Counted from the same filter the bound applies, so a malformed entry the
 *  builder discarded is not reported as a repository somebody could go and look
 *  up in the full report. */
function leftOutRepositoriesOmitted(
  value: RunAnalysisLeftOutRepository[] | undefined,
  kept: number,
): number {
  if (!Array.isArray(value)) return 0;
  const valid = value.filter(
    (repository) =>
      typeof repository?.repositoryKey === "string" && typeof repository?.reason === "string",
  ).length;
  return Math.max(0, valid - kept);
}

function sliceUtf8(value: string, maxBytes: number, direction: "head" | "tail"): string {
  const chars = Array.from(value);
  const selected: string[] = [];
  let bytes = 0;
  const source = direction === "head" ? chars : chars.reverse();
  for (const char of source) {
    const width = utf8Bytes(char);
    if (bytes + width > maxBytes) break;
    selected.push(char);
    bytes += width;
  }
  return direction === "head" ? selected.join("") : selected.reverse().join("");
}

function scrubComment(text: string): string {
  return scrubForPublication(text);
}

function withoutReservedCommentLines(value: string, marker: string): string {
  return value
    .split("\n")
    .map((line) => line
      .replaceAll(marker, "")
      .replace(/Arthur report:\s+[^\s]+:(?:research|pull_request)/giu, "")
      .replace(/Dashboard:\s+\S+/giu, ""))
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

export function formatResearchAnalysisComment(report: RunAnalysisReport, dashboardUrl: string): string {
  const marker = analysisCommentMarker(report.runId, "research");
  const sections = [
    `Arthur research complete\nRun: ${report.runId}`,
    // NOT "analyzed". The section carries the repositories this run left out as
    // well as the ones it opened, and a heading that calls all of them analyzed
    // says the opposite of the lines under it: a person reading that a
    // repository was analyzed, on a line saying it was left out, learns nothing
    // except that one of the two is lying.
    `Repositories\n${repositoryLines(report).join("\n")}`,
    `What was checked\n${report.evidenceStatus === "not_retained" ? "Source evidence was not retained." : report.evidence.length > 0 ? report.evidence.map((item, i) => `${i + 1}. ${item}`).join("\n") : "No evidence items were captured."}`,
    ...(report.noChangeNeeded
      ? [`Resolution evidence\n${report.resolutionEvidence.length > 0 ? report.resolutionEvidence.map((item, i) => `${i + 1}. ${item}`).join("\n") : "No resolution evidence was captured."}`]
      : []),
    `Decisions\nExpansion rounds: ${report.expansionRounds}\nRequests: ${report.repositoryRequests.map((request) => `${request.provider}:${request.repoPath}`).join(", ") || "none"}\nWrite repositories: ${report.writeRepositories.map((request) => `${request.provider}:${request.repoPath}`).join(", ") || "none"}`,
    `Implementation plan\n${report.planMarkdown || "No implementation plan was retained."}`,
    `Usage so far\n${usageLines(report.usage.research).join("\n")}`,
  ];
  return scrubComment(fitFormattedComment(sections, dashboardUrl, marker));
}

export function formatPublishedAnalysisComment(report: RunAnalysisReport, dashboardUrl: string): string {
  const marker = analysisCommentMarker(report.runId, "pull_request");
  const publication = report.publication;
  const sections = [
    `Arthur pull requests ready\n${publication?.prs.map((pr) => `- ${pr.provider}:${pr.repoPath} ${pr.url}`).join("\n") || "No pull requests were published."}`,
    `Implemented\n${publication?.changeSummary || "No implementation summary was retained."}`,
    `Repositories\n${repositoryLines(report).join("\n")}`,
    `Evidence\n${report.evidence.slice(0, 10).map((item) => `- ${item}`).join("\n") || "No evidence items were captured."}${report.evidence.length > 10 ? `\n- ${OMITTED}` : ""}`,
    `Implementation plan\n${report.planMarkdown || "No implementation plan was retained."}`,
    `Usage at publication\n${usageLines(report.usage.publication ?? report.usage.research).join("\n")}`,
  ];
  return scrubComment(fitFormattedComment(sections, dashboardUrl, marker));
}

function fitFormattedComment(sections: string[], dashboardUrl: string, marker: string): string {
  const reserved = [`Dashboard: ${dashboardUrl}`, marker];
  const mutable = sections.map((section) => withoutReservedCommentLines(section, marker));
  let body = [...mutable, ...reserved].join("\n\n");
  if (utf8Bytes(body) <= COMMENT_MAX_BYTES) return body;
  for (let index = 0; index < mutable.length; index += 1) {
    const section = mutable[index]!;
    if (!/(What was checked|Resolution evidence|Evidence|Implementation plan|Implemented)/.test(section)) continue;
    const lines = section.split("\n");
    mutable[index] = `${lines[0]}\n${OMITTED}`;
    body = [...mutable, ...reserved].join("\n\n");
    if (utf8Bytes(body) <= COMMENT_MAX_BYTES) return body;
  }
  const usage = mutable.find((section) => section.startsWith("Usage")) ?? "";
  const tail = `${usage}\n\nDashboard: ${dashboardUrl}\n\n${marker}`;
  // WHAT IT DROPPED, BY NAME. Everything between the first section and the usage
  // tail is gone at this point, the repositories this run left out with it, and
  // a truncation nobody is told about reads as "there was nothing to say": the
  // exact silence this comment exists to break. The headings are cheap, they are
  // this file's own words rather than anything a model wrote, and they tell a
  // reader which part of the run to go and look at.
  const droppedHeadings = mutable
    .slice(1)
    .filter((section) => section !== usage)
    .map((section) => section.split("\n")[0]?.trim() ?? "")
    .filter((heading) => heading.length > 0);
  const separator =
    droppedHeadings.length > 0
      ? `\n\n${OMITTED}. This comment was too long to post in full, so these sections were left out: ${droppedHeadings.join(", ")}.\n\n`
      : `\n\n${OMITTED}\n\n`;
  const budget = COMMENT_MAX_BYTES - utf8Bytes(tail) - utf8Bytes(separator);
  const heading = sliceUtf8(mutable[0] ?? "Arthur report", Math.max(0, budget), "head");
  return `${heading}${separator}${tail}`;
}
