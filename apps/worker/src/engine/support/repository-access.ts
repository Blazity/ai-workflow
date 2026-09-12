/**
 * May this run read, branch, promote or open a pull request on a repository?
 *
 * One answer, from the list the run-start step froze into the run context.
 * This replaced `engine/support/repo-allowlist.ts`, which re-read
 * `AGENT_ALLOWED_REPOS` on every call, and with it two behaviours that are
 * deliberately gone:
 *
 *   - a run no longer changes its mind mid-flight. The old module read the
 *     variable each time, so a deployment that changed it while a run was in
 *     flight gave that run two different answers about the same repository;
 *   - a workflow definition's repository PIN no longer extends access. A pin
 *     is a selection inside the catalog, which is what
 *     `services/dispatch/repo-allowlist.ts` already decided for dispatch, and
 *     a pin that could widen the in-run list would let a definition reach a
 *     repository the catalog refuses to dispatch events for.
 *
 * Everything here is synchronous and side effect free, because the callers are
 * inside loops over repository listings and inside step bodies where an await
 * per element would be a database round trip per element.
 *
 * The engine spells the repository path `repoPath` and the catalog spells it
 * `path`; this is the one place that adapts between them, so there is exactly
 * one definition of the key (`repositoryCatalogKey`, in the contracts package).
 */
import {
  isRepositoryAccessible,
  type RunRepositoryAccess,
  type VcsProviderKind,
} from "@shared/contracts";

/* There is deliberately no exported "unrestricted" constant here. The bridge is
 * a fail-open value, and a named one in reach of production code is an
 * invitation to paper over a missing parameter with it. Every seam that needs
 * the run's list takes it as a required field, so forgetting one is a
 * compile error; a caller that genuinely has no run writes the literal and says
 * why. Test fixtures take theirs from `test-support/settings.ts`. */

/** True when this run may touch the repository. */
export function mayRunTouchRepository(
  access: RunRepositoryAccess,
  repository: { provider: VcsProviderKind; repoPath: string },
): boolean {
  return isRepositoryAccessible(access, {
    provider: repository.provider,
    path: repository.repoPath,
  });
}

/** Drop every repository this run may not touch, preserving listing order. */
export function filterRunRepositories<
  T extends { provider: VcsProviderKind; repoPath: string },
>(access: RunRepositoryAccess, repositories: T[]): T[] {
  if (!access.activated) return repositories;
  return repositories.filter((repository) => mayRunTouchRepository(access, repository));
}

/**
 * The exact phrase every catalog refusal contains, and the only thing a
 * classifier may match on.
 *
 * A refusal is thrown inside a step and read again after it has crossed the
 * journal, where it is a string and no longer an instance of anything, so
 * `instanceof` cannot recognise it and a marker has to. It says "when this run
 * started" because that is the fact an operator gets wrong otherwise: the row
 * may well be enabled by the time they read the failure, and the run still
 * refuses, because the list was frozen at run start.
 *
 * Deliberately module-local: the two functions below are the only sanctioned
 * readers, and an exported marker invites a caller to hand-roll the sentence
 * or the test instead of going through `repositoryNotEnabledMessage` and
 * `isRepositoryCatalogRefusal`.
 */
const REPOSITORY_NOT_ENABLED_MARKER =
  "was not enabled in the repository catalog when this run started";

/** What a caller refused by the catalog inside a run is told. One sentence,
 *  because the operator's next action is the same everywhere it is shown, and
 *  it deliberately does not name an environment variable: the fix is a row on
 *  the Repositories page, and a re-dispatch, because the list this run holds
 *  cannot change under it. */
export function repositoryNotEnabledMessage(
  action: string,
  repository: { provider: VcsProviderKind; repoPath: string },
): string {
  return `Refusing to ${action} ${repository.provider}:${repository.repoPath}: this repository ${REPOSITORY_NOT_ENABLED_MARKER}. Enable it on the Repositories page and re-dispatch the ticket.`;
}

/**
 * The catalog is on and this run can reach nothing through it.
 *
 * Its own sentence rather than a refusal by name, because there is no name to
 * give: every repository the providers offer was dropped. Without it the run
 * falls into repository discovery with an empty catalog and asks a human which
 * repository to use, a question whose only honest answer is "none of them".
 */
export const NO_ENABLED_REPOSITORIES_MESSAGE =
  "The repository catalog is activated and enables no repository this run can reach. " +
  "Enable repositories on the Repositories page and re-dispatch.";

/**
 * Is this failure text a catalog refusal rather than an infrastructure fault?
 *
 * Matching text is the price of the journal boundary above. It buys the thing
 * that matters to an operator: a refusal classified as `configuration` leads
 * with the configuration sentence and names the page that fixes it, instead of
 * blaming a sandbox or a provider that did nothing wrong.
 */
export function isRepositoryCatalogRefusal(text: string): boolean {
  return (
    text.includes(REPOSITORY_NOT_ENABLED_MARKER) ||
    text.includes(NO_ENABLED_REPOSITORIES_MESSAGE)
  );
}
