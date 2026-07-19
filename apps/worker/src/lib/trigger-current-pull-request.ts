import type { PullRequestHead } from "../adapters/vcs/types.js";
import { createRepositoryVCS } from "./vcs-runtime.js";
import type { TriggerEvent } from "./trigger-events.js";

/** Re-read the provider facts needed to prove that a queued/bound trigger is
 * still the exact event that was accepted. */
export async function readProviderCurrentPullRequest(
  event: Pick<TriggerEvent, "triggerType" | "pr">,
): Promise<PullRequestHead> {
  const { pr } = event;
  const vcs = createRepositoryVCS({
    provider: pr.provider,
    repoPath: pr.repoPath,
    baseBranch: pr.baseRef,
  });
  let current = await vcs.getPRHead(pr.prNumber);
  if (pr.provider === "github" && (pr.failedChecks?.length ?? 0) > 0) {
    const latestCheckRuns =
      current.latestCheckRuns ??
      (vcs.getLatestCheckRuns
        ? await vcs.getLatestCheckRuns(current.headSha)
        : null);
    if (!latestCheckRuns) {
      throw new Error("GitHub latest Check Runs are unavailable");
    }
    current = { ...current, latestCheckRuns };
  }
  return current;
}

/** Bind a saved trigger envelope to current provider state. A null result is a
 * terminal stale event; a non-null result may narrow still-failed checks. */
export function bindCurrentPullRequest<T extends TriggerEvent>(
  event: T,
  current: PullRequestHead | null,
): T | null {
  if (!current) return null;
  const { pr } = event;
  if (current.baseRef !== pr.baseRef) return null;
  const expectedState =
    event.triggerType === "trigger_pr_merged" ? "merged" : "open";
  if (current.state !== expectedState) return null;
  if (pr.provider === "github") {
    if (current.headSha !== pr.headSha) return null;
    if (event.triggerType !== "trigger_pr_checks_failed") return event;
    const failedChecks = (pr.failedChecks ?? []).filter((failed) =>
      current.latestCheckRuns?.some(
        (latest) =>
          latest.id === failed.checkRunId &&
          latest.name === failed.name &&
          latest.appSlug === failed.appSlug &&
          latest.status === "completed" &&
          latest.conclusion === failed.conclusion,
      ),
    );
    if (failedChecks.length === 0) return null;
    return { ...event, pr: { ...pr, failedChecks } };
  }
  if (pr.pipelineId === undefined) {
    return current.headSha === pr.headSha ? event : null;
  }
  if (current.headPipelineId !== pr.pipelineId) return null;
  if (current.headPipelineStatus !== "failed") return null;
  if (pr.headSha && pr.headSha !== current.headSha) return null;
  const failedChecks = (pr.failedChecks ?? []).filter((failed) =>
    // GitLab may omit builds from a Pipeline Hook. The explicit pipeline
    // sentinel is backed by exact pipeline id plus current failed status above.
    failed.name === "pipeline" ||
    current.headPipelineFailedChecks?.some(
      (currentFailed) => currentFailed.name === failed.name,
    ),
  );
  if (failedChecks.length === 0) return null;
  return {
    ...event,
    pr: { ...pr, headSha: current.headSha, failedChecks },
  };
}
