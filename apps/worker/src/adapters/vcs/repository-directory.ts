import type { WorkflowRepositoryScope } from "@shared/contracts";
import type { VcsConfig, VcsProviderConfig } from "../../../env.js";
import { buildOctokit } from "../../lib/github-auth.js";
import { filterAllowedRepositories } from "../../lib/repo-allowlist.js";

const GITLAB_PROJECTS_TIMEOUT_MS = 15_000;

// One retry with a short backoff. A provider's 5xx or timeout is usually gone by
// the second call, while the pre-sandbox step that owns this listing runs under a
// 60s budget: a longer ladder would spend that budget hanging instead of failing
// with a reason an operator can act on.
const LISTING_MAX_ATTEMPTS = 2;
const LISTING_RETRY_DELAY_MS = 500;

export type VcsProvider = "github" | "gitlab";

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

export function createRepositoryDirectory(vcs: VcsProviderConfig | VcsConfig): RepositoryDirectory {
  if (vcs.kind === "github") return new GitHubRepositoryDirectory(vcs.auth);
  return new GitLabRepositoryDirectory(vcs.token, vcs.host);
}

export function createRepositoryDirectoryForProviders(
  providers: VcsProviderConfig[],
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
 * Latency budget for whoever tunes GITLAB_PROJECTS_TIMEOUT_MS next: the retry
 * doubles the worst case, so a hung provider costs about 30.5s here rather than
 * 15s, for every caller including the dashboard catalog endpoint. allSettled also
 * means the slowest provider sets the floor: a fast 401 next to a hung provider
 * now surfaces at the hung provider's pace instead of immediately.
 */
export async function listRepositoriesAcrossProviders(
  providers: VcsProviderConfig[],
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
  provider: VcsProviderConfig,
): Promise<RepositoryMetadata[]> {
  const directory = createRepositoryDirectory(provider);
  let lastError: unknown;
  for (let attempt = 1; attempt <= LISTING_MAX_ATTEMPTS; attempt++) {
    try {
      return await directory.listRepositories();
    } catch (err) {
      lastError = err;
      if (attempt >= LISTING_MAX_ATTEMPTS || !isTransientListingError(err)) break;
      await new Promise((resolve) => setTimeout(resolve, LISTING_RETRY_DELAY_MS));
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

class RepositoryListingError extends Error {
  readonly status: number | undefined;
  readonly timedOut: boolean;

  constructor(message: string, detail: { status?: number; timedOut?: boolean } = {}) {
    super(message);
    this.name = "RepositoryListingError";
    this.status = detail.status;
    this.timedOut = detail.timedOut ?? false;
  }
}

/**
 * Intersect a repository listing with the repositories pinned to a workflow
 * definition. Composes AFTER filterAllowedRepositories and can only remove
 * entries the server already offered: it never fetches, never builds a path, and
 * never re-admits an entry the allowlist dropped, so a pin can never widen
 * access. An absent or fully empty scope returns the input untouched, which is
 * what keeps a workflow without a pin on exactly its pre-pin behavior.
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
  constructor(private auth: Extract<VcsProviderConfig | VcsConfig, { kind: "github" }>["auth"]) {}

  async listRepositories(): Promise<RepositoryMetadata[]> {
    const octokit = buildOctokit(this.auth) as any;
    const repositories = await octokit.paginate(
      octokit.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );

    return filterAllowedRepositories(
      repositories.map((repo: any) => ({
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
      })),
    );
  }
}

class GitLabRepositoryDirectory implements RepositoryDirectory {
  constructor(
    private token: string,
    private host: string,
  ) {}

  async listRepositories(): Promise<RepositoryMetadata[]> {
    const projects: any[] = [];
    let page = "1";
    const baseUrl = this.host.replace(/\/$/, "");

    while (page) {
      const url = `${baseUrl}/api/v4/projects?membership=true&simple=true&per_page=100&page=${page}`;
      const response = await fetch(url, {
        headers: { "PRIVATE-TOKEN": this.token },
        signal: AbortSignal.timeout(GITLAB_PROJECTS_TIMEOUT_MS),
      }).catch((err) => {
        if (isAbortError(err)) {
          throw new RepositoryListingError(
            `GitLab projects list timed out after ${GITLAB_PROJECTS_TIMEOUT_MS}ms`,
            { timedOut: true },
          );
        }
        throw err;
      });
      if (!response.ok) {
        throw new RepositoryListingError(
          `GitLab projects list failed: ${response.status} ${response.statusText}`,
          { status: response.status },
        );
      }

      projects.push(...await response.json());
      page = response.headers.get("x-next-page") ?? "";
    }

    return filterAllowedRepositories(
      projects.map((project) => ({
        provider: "gitlab" as const,
        repoPath: project.path_with_namespace,
        name: project.name,
        owner: project.namespace?.full_path ?? project.path_with_namespace.split("/")[0],
        defaultBranch: project.default_branch ?? "",
        description: project.description ?? "",
        webUrl: project.web_url,
        topics: project.topics ?? project.tag_list ?? [],
        archived: Boolean(project.archived),
        private: project.visibility !== "public",
      })),
    );
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
}
