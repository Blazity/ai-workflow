import type { VcsConfig, VcsProviderConfig } from "../../../env.js";
import { buildOctokit } from "../../lib/github-auth.js";

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

class GitHubRepositoryDirectory implements RepositoryDirectory {
  constructor(private auth: Extract<VcsProviderConfig | VcsConfig, { kind: "github" }>["auth"]) {}

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
      defaultBranch: repo.default_branch ?? "main",
      description: repo.description ?? "",
      webUrl: repo.html_url,
      topics: repo.topics ?? [],
      archived: Boolean(repo.archived),
      private: Boolean(repo.private),
    }));
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
      });
      if (!response.ok) {
        throw new Error(`GitLab projects list failed: ${response.status} ${response.statusText}`);
      }

      projects.push(...await response.json());
      page = response.headers.get("x-next-page") ?? "";
    }

    return projects.map((project) => ({
      provider: "gitlab" as const,
      repoPath: project.path_with_namespace,
      name: project.name,
      owner: project.namespace?.full_path ?? project.path_with_namespace.split("/")[0],
      defaultBranch: project.default_branch ?? "main",
      description: project.description ?? "",
      webUrl: project.web_url,
      topics: project.topics ?? project.tag_list ?? [],
      archived: Boolean(project.archived),
      private: project.visibility !== "public",
    }));
  }
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
