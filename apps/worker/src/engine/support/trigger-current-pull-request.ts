import type { PullRequestHead, VcsOpaqueHandle } from "../../adapters/vcs/types.js";
import type { TriggerEvent } from "@shared/contracts";
import { createRepositoryVCS } from "./vcs-runtime.js";

/** Re-read the provider facts needed to prove that a queued/bound trigger is
 * still the exact event that was accepted. */
export async function readProviderCurrentPullRequest(
  event: Pick<TriggerEvent, "triggerType" | "pr">,
): Promise<{
  current: PullRequestHead;
  sameHandle: (left: VcsOpaqueHandle | undefined, right: VcsOpaqueHandle | undefined) => boolean;
}> {
  const { pr } = event;
  const vcs = createRepositoryVCS({
    provider: pr.provider,
    repoPath: pr.repoPath,
    baseBranch: pr.baseRef,
  });
  return {
    current: await vcs.getPRHead(pr.prNumber),
    sameHandle: (left, right) => vcs.sameHandle(left, right),
  };
}

/** Bind a saved trigger envelope to current provider state. A null result is a
 * terminal stale event; a non-null result may narrow still-failed checks. */
export function bindCurrentPullRequest<T extends TriggerEvent>(
  event: T,
  current: PullRequestHead | null,
  sameHandle: (
    left: VcsOpaqueHandle | undefined,
    right: VcsOpaqueHandle | undefined,
  ) => boolean = (left, right) => left === right,
): T | null {
  if (!current) return null;
  const { pr } = event;
  // Review triggers are about the PR, not a specific head. A comment event may
  // carry no base ref (issue_comment), so an empty pr.baseRef means "unknown,
  // adopt the provider-authoritative value" rather than "stale".
  const isReview = event.triggerType === "trigger_pr_review";
  if (current.baseRef !== pr.baseRef && !(isReview && pr.baseRef === "")) return null;
  const expectedState =
    event.triggerType === "trigger_pr_merged" ? "merged" : "open";
  if (current.state !== expectedState) return null;
  if (isReview) {
    if (pr.headSha && pr.headSha !== current.headSha) return null;
    const headRef = pr.headRef || current.headRef || "";
    if (!headRef) return null;
    return {
      ...event,
      pr: { ...pr, headRef, headSha: current.headSha, baseRef: current.baseRef },
    };
  }
  // A checks event may not know the head: the delivery names the commit its
  // checks ran on, which is not always the pull request's head (a merged-results
  // pipeline runs on a temporary merge commit). Its failed-check handles are
  // what prove it is about this head, below, so an empty head is "unknown,
  // adopt the provider's" there and stale for every other trigger.
  const headUnknown = pr.headSha === "" && event.triggerType === "trigger_pr_checks_failed";
  if (!headUnknown && current.headSha !== pr.headSha) return null;
  if (event.triggerType !== "trigger_pr_checks_failed") return event;
  if (!current.checks || current.checks.state !== "red") return null;
  const currentChecks = current.checks;
  const failedChecks = (pr.failedChecks ?? []).filter((failed) =>
    currentChecks.failed.some(
      (currentFailed) =>
        currentFailed.name === failed.name &&
        currentFailed.conclusion === failed.conclusion &&
        sameHandle(
          currentFailed.handle,
          failed.handle as VcsOpaqueHandle | undefined,
        ),
    ),
  );
  if (failedChecks.length === 0) return null;
  return {
    ...event,
    pr: { ...pr, headSha: current.headSha, failedChecks },
  };
}
