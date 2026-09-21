import type { WorkflowRepositoryScope } from "@shared/contracts";
import { buildOctokit } from "./github-auth.js";

type RepositoryProviderConfig =
  { kind: "github"; auth: Parameters<typeof buildOctokit>[0]; host?: string } & {
    repoPath?: string;
    baseBranch?: string;
    legacyRepoPath?: string;
    legacyBaseBranch?: string;
  };

// A few bounded retries with jittered exponential backoff. A provider's 5xx or
// timeout is usually gone within a couple of calls, while the pre-sandbox step
// that owns this listing runs under a 60s budget: a longer ladder would spend
// that budget hanging instead of failing with a reason an operator can act on.
// Worst case is 3 * 18s + <=1.5s of backoff ~= 55.5s, which stays inside that
// budget while surviving a provider hiccup that outlasts a single call.
const LISTING_MAX_ATTEMPTS = 3;
const LISTING_RETRY_BASE_DELAY_MS = 500;
const LISTING_RETRY_MAX_DELAY_MS = 4_000;

/** Jittered exponential backoff between listing attempts: after the nth attempt
 *  fails the next wait is a random span in [0, base * 2^(n-1)] capped at
 *  LISTING_RETRY_MAX_DELAY_MS. Full jitter de-correlates retries that a shared
 *  upstream blip fired at once, and the cap keeps the ladder inside the budget. */
function listingRetryDelayMs(failedAttempt: number): number {
  const ceiling = Math.min(
    LISTING_RETRY_MAX_DELAY_MS,
    LISTING_RETRY_BASE_DELAY_MS * 2 ** (failedAttempt - 1),
  );
  return Math.floor(Math.random() * ceiling);
}

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

export interface RepositoryDirectory {
  listRepositories(): Promise<RepositoryMetadata[]>;
}

export function createRepositoryDirectory(vcs: RepositoryProviderConfig): RepositoryDirectory {
  return new GitHubRepositoryDirectory(vcs.auth);
}

export function createRepositoryDirectoryForProviders(
  providers: RepositoryProviderConfig[],
): RepositoryDirectory {
  return {
    async listRepositories() {
      const { repositories, failures } = await listRepositoriesAcrossProviders(providers);
      // Callers of this directory have no partial-catalog contract, so a provider
      // that never answered stays terminal for them exactly as before, with its
      // own error rather than a wrapper.
      if (failures.length > 0) throw failures[0]!.error;
      return repositories;
    },
  };
}

export interface RepositoryListingFailure {
  provider: VcsProvider;
  message: string;
  error: unknown;
}

/**
 * Fan out over the configured providers and report what each one did, so a caller
 * that can reason about a partial catalog gets the surviving listings plus the
 * providers that failed instead of a single rejection standing in for all of them.
 * Each provider's listing is retried under a bounded policy first.
 *
 * The bounded retry ladder is shared by every core provider listing.
 */
export async function listRepositoriesAcrossProviders(
  providers: RepositoryProviderConfig[],
): Promise<{
  repositories: RepositoryMetadata[];
  failures: RepositoryListingFailure[];
}> {
  const settled = await Promise.allSettled(
    providers.map((provider) => listRepositoriesWithRetry(provider)),
  );
  const repositories: RepositoryMetadata[] = [];
  const failures: RepositoryListingFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      repositories.push(...result.value);
      return;
    }
    failures.push({
      provider: providers[index]!.kind,
      message: listingErrorMessage(result.reason),
      error: result.reason,
    });
  });
  return { repositories, failures };
}

async function listRepositoriesWithRetry(
  provider: RepositoryProviderConfig,
): Promise<RepositoryMetadata[]> {
  const directory = createRepositoryDirectory(provider);
  let lastError: unknown;
  for (let attempt = 1; attempt <= LISTING_MAX_ATTEMPTS; attempt++) {
    try {
      return await directory.listRepositories();
    } catch (err) {
      lastError = err;
      if (attempt >= LISTING_MAX_ATTEMPTS || !isTransientListingError(err)) break;
      await new Promise((resolve) => {
        setTimeout(resolve, listingRetryDelayMs(attempt));
      });
    }
  }
  throw lastError;
}

/** Retry only what the provider can recover from without us changing anything: a
 *  timeout or a 5xx. A 401 or 403 is a credential the retry would replay
 *  unchanged, and every other 4xx is a request this code will keep sending. */
function isTransientListingError(err: unknown): boolean {
  if (isAbortError(err)) return true;
  if (typeof err !== "object" || err === null) return false;
  if ((err as { timedOut?: unknown }).timedOut === true) return true;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && status >= 500 && status < 600;
}

function listingErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** A pinned repoPath is stored in the case the operator picked, so every
 *  comparison lowercases it, exactly like repositoryKey in
 *  pre-sandbox/steps/repo-selection.ts and repositoryCatalogKey. */
function pinnedRepositoryKey(repository: {
  provider: VcsProvider;
  repoPath: string;
}): string {
  return `${repository.provider}:${repository.repoPath.toLowerCase()}`;
}

class GitHubRepositoryDirectory implements RepositoryDirectory {
  constructor(private auth: Extract<RepositoryProviderConfig, { kind: "github" }>["auth"]) {}

  async listRepositories(): Promise<RepositoryMetadata[]> {
    const octokit = buildOctokit(this.auth) as any;
    const repositories = await octokit.paginate(
      octokit.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );

    return repositories.map((repo: any) => ({
      provider: "github" as const,
      repoPath: repo.full_name,
      name: repo.name,
      owner: repo.owner?.login ?? repo.full_name.split("/")[0],
      defaultBranch: repo.default_branch ?? "",
      description: repo.description ?? "",
      webUrl: repo.html_url,
      topics: repo.topics ?? [],
      archived: Boolean(repo.archived),
      private: Boolean(repo.private),
    }));
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
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
