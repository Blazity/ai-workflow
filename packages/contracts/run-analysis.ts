import type { RunPullRequest } from "./domain";
import type { ReplaySanitizationMetadata } from "./run-replay";

export type RunAnalysisStage =
  | "research_complete"
  | "published"
  | "no_change";

export interface RunAnalysisRepository {
  provider: string;
  repoPath: string;
  defaultBranch: string;
  researchBranch: string;
  researchBaseSha: string | null;
  access: "read" | "write";
  rationale: string;
}

/**
 * A repository a run was asked to work on and did not, with the sentence that
 * says why.
 *
 * Deliberately NOT a `RunAnalysisRepository` with its fields left blank: a
 * repository the run never opened has no research branch, no base SHA and no
 * access, and filling those with placeholders would put a repository that was
 * left out in the same shape as one that was worked on. What a reader needs is
 * which repository and why, and the why has to be a sentence they can act on,
 * because the action is theirs (somebody excluded it, and only a person can
 * take that back).
 */
export interface RunAnalysisLeftOutRepository {
  /** `provider:owner/name`, the same key the work scope record and the run's
   *  own drop observation use, so the three can be lined up. */
  repositoryKey: string;
  /** Why the run left it out, as a person reads it. */
  reason: string;
}

export interface RunAnalysisRepositoryRequest {
  provider: string;
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
  /** Repositories the run was asked to work on and did not.
   *
   *  Optional, and absent rather than empty when there are none: a report
   *  written before this field existed must go on parsing, and a run that left
   *  nothing out says nothing rather than saying "left out: none". */
  leftOutRepositories?: RunAnalysisLeftOutRepository[];
  /** What a person can do about the repositories above, in whole sentences.
   *
   *  Separate from the reasons beside each repository because it is addressed to
   *  a reader rather than to a line: at most one sentence saying an exclusion
   *  can be taken back, and one saying the catalog cannot serve a repository
   *  today. Said once for the whole list, not repeated under every key.
   *
   *  Optional and absent rather than empty, for the same reason as the field
   *  above: a report written before it existed must go on parsing, and a run
   *  with nothing to offer says nothing. */
  repositoryRecoveryNotes?: string[];
  /** How many left-out repositories the storage bound dropped from the list
   *  above.
   *
   *  Said rather than implied, the way the work scope trail bound says it
   *  (`engine/work-scope/context.ts`, "and N more"). A person reading eight
   *  lines has no way to tell eight from ten, and a truncation nobody is told
   *  about reads as "there was nothing more to say", which is the exact silence
   *  this section exists to break. Absent when nothing was dropped. */
  leftOutRepositoriesOmitted?: number;
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
