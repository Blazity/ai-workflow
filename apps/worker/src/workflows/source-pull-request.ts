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
  if (current.headSha !== input.headSha) {
    throw new Error(
      `stale PR/MR head for ${sourcePullRequestLabel(input)}: triggered at ${input.headSha}, ` +
        `current head is ${current.headSha}`,
    );
  }
  assertPublishableSourcePullRequest(input, current);
}

/**
 * Target branch and lifecycle only, deliberately without the head comparison.
 *
 * A fix agent commits AND pushes from inside the sandbox, so by the time
 * publication starts the pull request head is routinely this run's own work
 * rather than the sha recorded when the trigger fired. Comparing the two here
 * failed every run that actually repaired its checks, with the fix already on
 * the branch and CI already green. Head staleness is decided where it can be
 * proven instead: publication accepts a moved remote head only while the
 * workspace contains it (`merge-base --is-ancestor`) and still fails a foreign
 * write as remote drift, and the post-push check compares against the exact sha
 * publication produced.
 */
export function assertPublishableSourcePullRequest(
  input: SourcePullRequestIdentity,
  current: PullRequestHead,
): void {
  const identity = sourcePullRequestLabel(input);
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

function sourcePullRequestLabel(input: SourcePullRequestIdentity): string {
  return `${input.provider}:${input.repoPath} #${input.prId}`;
}

export function isSourcePullRequestRepository(
  source: SourcePullRequestIdentity,
  repository: Pick<SelectedRepository, "provider" | "repoPath">,
): boolean {
  return source.provider === repository.provider && source.repoPath === repository.repoPath;
}
