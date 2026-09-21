import { pullRequestRef, type RunPullRequest, type VcsProviderKind } from "@shared/contracts";
import { integrationManifests } from "@integrations/registry";

/** The PR-carrying fields of a Run/RunDetail, so both shapes can be passed in. */
interface RunPrRefs {
  prs: RunPullRequest[] | null;
  prUrl: string | null;
  prNumber: number | null;
}

/** Legacy rows predate the provider field and came from core's original provider. */
function providerFromUrl(url: string): VcsProviderKind {
  if (url.includes("/-/merge_requests/")) {
    const integration = integrationManifests.find((manifest) =>
      manifest.capabilities.includes("vcs"),
    );
    if (integration) return integration.id;
  }
  return "github";
}

function pullRequestNoun(pr: RunPullRequest): { noun: string; sigil: string } {
  return pr.url.includes("/-/merge_requests/")
    ? { noun: "MR", sigil: "!" }
    : { noun: "PR", sigil: "#" };
}

/**
 * Every PR/MR to render for a run.
 *
 * Runs recorded before `prs` existed - and gate runs, which never populate it -
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

export function primaryPullRequestLabel(run: RunPrRefs): string | null {
  const primary = runPullRequests(run)[0];
  if (!primary) return null;
  const { noun, sigil } = pullRequestNoun(primary);
  return `${noun} ${pullRequestRef(primary).replace("#", sigil)}`;
}
