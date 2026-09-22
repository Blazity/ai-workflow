import type { VcsHandleIdentity } from "@integrations/sdk";
import type { TriggerEvent } from "@shared/contracts";
import type { PullRequestHead, VcsOpaqueHandle } from "../../adapters/vcs/types.js";
import { createRepositoryVCS, vcsHandleIdentity } from "./vcs-runtime.js";

/**
 * What the provider says about the pull request now, and how its handles
 * compare. The head needs this repository's connection; the comparison needs
 * none and comes from the provider itself.
 */
export async function readProviderCurrentPullRequest(
  event: Pick<TriggerEvent, "triggerType" | "pr">,
): Promise<{ current: PullRequestHead; handles: VcsHandleIdentity }> {
  const { pr } = event;
  const vcs = createRepositoryVCS({
    provider: pr.provider,
    repoPath: pr.repoPath,
    baseBranch: pr.baseRef,
  });
  const [current, handles] = await Promise.all([
    vcs.getPRHead(pr.prNumber),
    vcsHandleIdentity(pr.provider),
  ]);
  return { current, handles };
}

/** Bind a saved trigger envelope to current provider state. A null result is a
 * terminal stale event; a non-null result may narrow still-failed checks. */
export function bindCurrentPullRequest<T extends TriggerEvent>(
  event: T,
  current: PullRequestHead | null,
  handles: VcsHandleIdentity,
): T | null {
  if (!current) return null;
  const { pr } = event;
  // Review triggers are about the PR, not a specific head (see `headSha` on
  // `PrTriggerPayload`). A comment event may carry no base ref (issue_comment),
  // so an empty pr.baseRef means "unknown, adopt the provider-authoritative
  // value" rather than "stale".
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
  // What an empty head means per trigger is the contract's (`headSha` on
  // `PrTriggerPayload`): for a checks event, the failed-check handles below
  // are what prove it is about this head.
  const headUnknown = pr.headSha === "" && event.triggerType === "trigger_pr_checks_failed";
  if (!headUnknown && current.headSha !== pr.headSha) return null;
  if (event.triggerType !== "trigger_pr_checks_failed") return event;
  if (!current.checks || current.checks.state !== "red") return null;
  const currentChecks = current.checks;
  const failedChecks = (pr.failedChecks ?? []).filter((failed) => {
    // An envelope recorded before checks carried a handle still binds: the
    // provider that wrote it rebuilds the handle from its own old fields.
    const recorded =
      (failed.handle as VcsOpaqueHandle | undefined) ??
      handles.recordedCheckHandle?.(failed, pr as unknown as Readonly<Record<string, unknown>>) ??
      null;
    return (
      recorded !== null &&
      currentChecks.failed.some(
        (currentFailed) =>
          currentFailed.name === failed.name &&
          currentFailed.conclusion === failed.conclusion &&
          handles.sameHandle(currentFailed.handle, recorded),
      )
    );
  });
  if (failedChecks.length === 0) return null;
  return {
    ...event,
    pr: { ...pr, headSha: current.headSha, failedChecks },
  };
}
