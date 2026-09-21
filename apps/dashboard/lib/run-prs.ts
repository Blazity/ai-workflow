import { pullRequestRef, type RunPullRequest, type VcsProviderKind } from "@shared/contracts";
import { integrationsProviding } from "@integrations/registry";

/** The PR-carrying fields of a Run/RunDetail, so both shapes can be passed in. */
interface RunPrRefs {
  prs: RunPullRequest[] | null;
  prUrl: string | null;
  prNumber: number | null;
}

/**
 * Which provider a legacy row belongs to, when there is only one answer it
 * could have.
 *
 * Legacy rows predate the provider field, so the provider was never stored and
 * the URL is all that is left. Reading a provider out of that URL means knowing
 * one provider's link shape, and the guess is wrong on every deployment that
 * does not ship the provider guessed at. A deployment with a single version
 * control integration has one truthful answer, and every other deployment has
 * none: the row is then left without a provider rather than attributed to one
 * it may never have used. Nothing on screen reads this field, so an empty one
 * shows a person nothing; an invented one would show them a lie.
 *
 * It takes the ids rather than reading the registry so that the rule can be
 * driven for a deployment with one provider and for one with several, which is
 * the whole of it and neither of which this build's own registry is.
 */
export function soleVcsProvider(providerIds: readonly string[]): VcsProviderKind {
  return providerIds.length === 1 ? providerIds[0]! : "";
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
 * single legacy PR is not. `provider` is empty for the same reason wherever the
 * deployment ships more than one, and the link still says PR or MR because that
 * comes from the URL the row did store.
 */
export function runPullRequests(run: RunPrRefs): RunPullRequest[] {
  if (run.prs && run.prs.length > 0) return run.prs;
  if (!run.prUrl || run.prNumber == null) return [];
  return [
    {
      provider: soleVcsProvider(
        integrationsProviding("vcs").map((manifest) => manifest.id),
      ),
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
