import { repositoryCatalogKey, type WorkflowRepositoryScope } from "@shared/contracts";

/**
 * What core still says about a repository listing.
 *
 * Fetching one is no longer here. Until S11 this file also held a GitHub client
 * and the fan-out over the providers core was configured with; both left with
 * the GitHub integration, and a listing now comes from the `vcs` capability
 * (`listVcsRepositories` in `engine/support/vcs-runtime.ts`), which
 * is also where the bounded retry ladder that used to live here now runs. What
 * stays is the vocabulary a listing is described in and the pin filters, which
 * decide nothing about a provider and everything about a workflow's scope.
 */

export type VcsProvider = string;

export interface RepositoryMetadata {
  provider: VcsProvider;
  repoPath: string;
  name: string;
  owner: string;
  defaultBranch: string;
  description: string;
  webUrl: string;
  topics: string[];
  archived: boolean;
  private: boolean;
}

/** What one provider's listing failing looks like to a caller that can carry
 *  on with a partial catalog. */
export interface RepositoryListingFailure {
  provider: VcsProvider;
  message: string;
  error: unknown;
}

/**
 * Intersect a repository listing with the repositories pinned to a workflow
 * definition. It can only remove entries the caller already offered: it never
 * fetches, never builds a path, and never re-admits an entry that was dropped
 * before it, so a pin can never widen access. Inside a run the catalog filter
 * (`engine/support/repository-access.ts`) composes before this one, and a pin
 * the catalog withholds is refused by name earlier still, in the pre-sandbox
 * selection. An absent or fully empty scope returns the input untouched, which
 * is what keeps a workflow without a pin on exactly its pre-pin behavior.
 */
export function filterPinnedRepositories<
  T extends { provider: VcsProvider; repoPath: string },
>(repositories: T[], scope: WorkflowRepositoryScope | undefined): T[] {
  const providers = scope?.providers ?? [];
  const pinned = scope?.repositories ?? [];
  let filtered = repositories;
  if (providers.length > 0) {
    filtered = filtered.filter((repository) => providers.includes(repository.provider));
  }
  if (pinned.length > 0) {
    const keys = new Set(pinned.map(pinnedRepositoryKey));
    filtered = filtered.filter((repository) => keys.has(pinnedRepositoryKey(repository)));
  }
  return filtered;
}

/**
 * Whether the pin already excludes every repository a provider could offer, so
 * that provider's catalog cannot change what this run selects. Derived from the
 * same intersection filter, so it can never drift from it. The provider narrowing
 * in pre-sandbox/steps/repo-selection.ts keeps a provider-pinned run from even
 * querying an excluded provider; this answers the case that narrowing leaves
 * behind, a pin that names repositories without naming providers, where every
 * provider is still queried but only the named ones can survive the filter.
 */
export function pinnedScopeExcludesProvider(
  scope: WorkflowRepositoryScope | undefined,
  provider: VcsProvider,
): boolean {
  const providers = scope?.providers ?? [];
  const pinned = scope?.repositories ?? [];
  if (providers.length === 0 && pinned.length === 0) return false;
  if (pinned.length > 0) {
    return !filterPinnedRepositories(pinned, scope).some(
      (repository) => repository.provider === provider,
    );
  }
  return !providers.includes(provider);
}

/** Whether one repository identity survives the pin. Derived from the filter so
 *  trigger admission and repository selection can never drift apart. */
export function isRepositoryWithinPinnedScope(
  scope: WorkflowRepositoryScope | undefined,
  repository: { provider: VcsProvider; repoPath: string },
): boolean {
  return filterPinnedRepositories([repository], scope).length === 1;
}

/** A pinned repoPath is stored in the case the operator picked, so it is
 *  compared by the catalog's key, which lowercases the path. (The engine's
 *  `repositoryKey` is the same key; adapters may not import the engine.) */
function pinnedRepositoryKey(repository: {
  provider: VcsProvider;
  repoPath: string;
}): string {
  return repositoryCatalogKey({ provider: repository.provider, path: repository.repoPath });
}

export interface WorkflowOwnedBranch {
  branchName: string;
  pr?: {
    id: number;
    url: string;
    branch: string;
  };
}

export interface SelectedRepository {
  provider: VcsProvider;
  repoPath: string;
  defaultBranch: string;
  selectedRationale: string;
  workflowOwnedBranch?: WorkflowOwnedBranch;
  /** PR context for a read-only sibling checkout. It never grants write scope. */
  reviewPullRequest?: {
    id: number;
    url: string;
    branch: string;
    headSha?: string;
  };
}
