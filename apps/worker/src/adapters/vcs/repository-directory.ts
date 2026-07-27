import type { WorkflowRepositoryScope } from "@shared/contracts";
import type { VcsConfig, VcsProviderConfig } from "../../../env.js";
import { buildOctokit } from "../../lib/github-auth.js";
import { filterAllowedRepositories } from "../../lib/repo-allowlist.js";

const GITLAB_PROJECTS_TIMEOUT_MS = 15_000;

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
      const lists = await Promise.all(
        providers.map((provider) => createRepositoryDirectory(provider).listRepositories()),
      );
      return lists.flat();
    },
  };
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
          throw new Error(`GitLab projects list timed out after ${GITLAB_PROJECTS_TIMEOUT_MS}ms`);
        }
        throw err;
      });
      if (!response.ok) {
        throw new Error(`GitLab projects list failed: ${response.status} ${response.statusText}`);
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
