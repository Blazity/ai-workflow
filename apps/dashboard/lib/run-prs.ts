import type { RunPullRequest, VcsProviderKind } from "@shared/contracts";

/** The PR-carrying fields of a Run/RunDetail, so both shapes can be passed in. */
interface RunPrRefs {
  prs: RunPullRequest[] | null;
  prUrl: string | null;
  prNumber: number | null;
}

/**
 * GitLab MR web URLs always contain the `/-/merge_requests/` segment; every
 * other shape we store is a GitHub pull URL. Only used for legacy rows — runs
 * recorded since the `prs` list exists carry their provider explicitly.
 */
function providerFromUrl(url: string): VcsProviderKind {
  return url.includes("/-/merge_requests/") ? "gitlab" : "github";
}

/**
 * Every PR/MR to render for a run.
 *
 * Runs recorded before `prs` existed — and gate runs, which never populate it —
 * only have the single `prUrl`/`prNumber`, so those are lifted into a one-entry
 * list rather than dropped. `repoPath` is empty for them: the repository was
 * never stored, and callers only use it to disambiguate multi-PR runs, which a
 * single legacy PR is not.
 */
export function runPullRequests(run: RunPrRefs): RunPullRequest[] {
  if (run.prs && run.prs.length > 0) return run.prs;
  if (!run.prUrl || run.prNumber == null) return [];
  return [
    {
      provider: providerFromUrl(run.prUrl),
      repoPath: "",
      id: run.prNumber,
      url: run.prUrl,
    },
  ];
}
