import type { RunPullRequest } from "./domain.js";
import type { ReplaySanitizationMetadata } from "./run-replay.js";

export type RunAnalysisStage =
  | "research_complete"
  | "published"
  | "no_change";

export interface RunAnalysisRepository {
  provider: "github" | "gitlab";
  repoPath: string;
  defaultBranch: string;
  researchBranch: string;
  researchBaseSha: string | null;
  access: "read" | "write";
  rationale: string;
}

export interface RunAnalysisRepositoryRequest {
  provider: "github" | "gitlab";
  repoPath: string;
  rationale: string;
}

export interface RunAnalysisPhaseUsage {
  costUsd: number | null;
  tokens: {
    input: number;
    cachedInput: number;
    output: number;
  } | null;
  durationMs: number;
  numTurns: number;
  model: string | null;
}

export interface RunAnalysisUsageSnapshot {
  capturedAt: string;
  costUsd: number;
  costKnown: boolean;
  tokensInput: number | null;
  tokensCached: number | null;
  tokensOutput: number | null;
  phases: Record<string, RunAnalysisPhaseUsage>;
}

export interface RunAnalysisCommentDelivery {
  state: "not_applicable" | "pending" | "posted" | "failed";
  attemptedAt: string | null;
  commentUrl: string | null;
  error: string | null;
}

export interface RunAnalysisReport {
  version: 1;
  runId: string;
  sourceResearchRunId: string;
  researchRevision: number;
  stage: RunAnalysisStage;
  researchCompletedAt: string;
  repositories: RunAnalysisRepository[];
  expansionRounds: number;
  repositoryRequests: RunAnalysisRepositoryRequest[];
  writeRepositories: RunAnalysisRepositoryRequest[];
  evidenceStatus: "captured" | "not_retained";
  evidence: string[];
  planMarkdown: string;
  noChangeNeeded: boolean;
  resolutionEvidence: string[];
  publication: {
    prs: RunPullRequest[];
    changeSummary: string;
  } | null;
  usage: {
    research: RunAnalysisUsageSnapshot;
    publication: RunAnalysisUsageSnapshot | null;
    final: RunAnalysisUsageSnapshot | null;
  };
  jira: {
    research: RunAnalysisCommentDelivery;
    pullRequest: RunAnalysisCommentDelivery;
  };
  sanitization: ReplaySanitizationMetadata;
}
