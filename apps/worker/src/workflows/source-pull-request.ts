import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import type { PullRequestHead } from "../adapters/vcs/types.js";

export interface SourcePullRequestIdentity {
  provider: SelectedRepository["provider"];
  repoPath: string;
  prId: number;
  headSha: string;
  baseRef: string;
}

export function assertOpenSourcePullRequest(
  input: SourcePullRequestIdentity,
  current: PullRequestHead,
): void {
  const identity = `${input.provider}:${input.repoPath} #${input.prId}`;
  if (current.headSha !== input.headSha) {
    throw new Error(
      `stale PR/MR head for ${identity}: triggered at ${input.headSha}, ` +
        `current head is ${current.headSha}`,
    );
  }
  if (current.baseRef !== input.baseRef) {
    throw new Error(
      `stale PR/MR target for ${identity}: triggered at ${input.baseRef}, ` +
        `current target is ${current.baseRef}`,
    );
  }
  if (current.state !== "open") {
    throw new Error(
      `source PR/MR ${identity} is ${current.state}; remediation publication requires it to be open`,
    );
  }
}

export function isSourcePullRequestRepository(
  source: SourcePullRequestIdentity,
  repository: Pick<SelectedRepository, "provider" | "repoPath">,
): boolean {
  return source.provider === repository.provider && source.repoPath === repository.repoPath;
}
