/**
 * What a GitLab repository says about itself.
 *
 * Raw REST with the deployment's private token, the same way the GitLab
 * repository directory lists projects: the gitbeaker client covers neither the
 * languages endpoint nor a raw file read cleanly, and a second client here
 * would be a second place a token has to be threaded.
 *
 * Every read is best effort, for the same reason as the GitHub source: a
 * repository with no README and no manifests is ordinary, and it still gets a
 * bundle carrying the provider's own metadata.
 *
 * **Two bounds worth knowing before you read the code.** The whole read shares
 * ONE `AbortSignal.timeout` (`REPOSITORY_PROFILE_DEADLINE_MS`), not a timeout
 * per request: a dozen sequential requests each under their own 18 second bound
 * would add up to minutes. And the root listing is **one page of 100 entries**;
 * a repository with more files than that in its root can have a manifest this
 * never sees, so a full page is recorded as a truncation and the prompt says so
 * rather than letting the model read "no package.json" as a fact.
 */
import {
  boundRepositoryProfileBundle,
  isRepositoryProfileLockfile,
  isRepositoryProfileManifest,
  pickRepositoryProfileReadme,
  RepositoryMissingAtProviderError,
  REPOSITORY_PROFILE_DEADLINE_MS,
  REPOSITORY_PROFILE_MAX_CI_FILES,
  REPOSITORY_PROFILE_MAX_MANIFESTS,
  type RepositoryProfileBundle,
  type RepositoryProfileFile,
  type RepositoryProfileSource,
} from "../repository-profile-source.js";

/** One page of the root listing. Kept at one page deliberately: paging a
 *  repository root is unbounded work for a diminishing signal, and a root with
 *  more than a hundred entries tells the model more by being reported as
 *  truncated than by being read in full. */
const GITLAB_ROOT_TREE_PAGE_SIZE = 100;

/** The CI definitions GitLab keeps at the root, in the order it resolves
 *  them. Only the default path is read: a project that moved its CI file with
 *  `ci_config_path` is telling the provider, not the repository, and that is a
 *  setting rather than a file. */
const GITLAB_CI_FILES = [".gitlab-ci.yml", ".gitlab-ci.yaml"] as const;

interface GitLabTreeEntry {
  name?: string;
  type?: string;
}

class GitLabProfileSource implements RepositoryProfileSource {
  private readonly baseUrl: string;
  private readonly projectId: string;

  constructor(
    private readonly token: string,
    host: string,
    private readonly repoPath: string,
  ) {
    this.baseUrl = host.replace(/\/$/u, "");
    this.projectId = encodeURIComponent(repoPath);
  }

  async loadProfile(): Promise<RepositoryProfileBundle> {
    const signal = AbortSignal.timeout(REPOSITORY_PROFILE_DEADLINE_MS);
    // The project's own metadata first, and its 404 is not "this path holds
    // nothing" like every other 404 here: it is the repository being gone.
    // Read as an absent README it would produce a bundle of empty strings and
    // a confident description of a repository nobody can open.
    const project = await this.json<{ default_branch?: string; description?: string }>(
      `/projects/${this.projectId}`,
      signal,
    );
    if (!project) {
      throw new RepositoryMissingAtProviderError("gitlab", this.repoPath);
    }
    const languages = await this.json<Record<string, number>>(
      `/projects/${this.projectId}/languages`,
      signal,
    );
    const defaultBranch = project.default_branch ?? "";

    const tree = defaultBranch
      ? await this.json<GitLabTreeEntry[]>(
          `/projects/${this.projectId}/repository/tree?ref=${encodeURIComponent(defaultBranch)}&per_page=${GITLAB_ROOT_TREE_PAGE_SIZE}`,
          signal,
        )
      : null;
    const treeEntries = Array.isArray(tree) ? tree : [];
    const rootFiles = treeEntries
      .filter((entry) => entry.type === "blob" && typeof entry.name === "string")
      .map((entry) => entry.name as string);

    const readmeName = pickRepositoryProfileReadme(rootFiles);
    const readme = readmeName ? await this.raw(readmeName, defaultBranch, signal) : null;

    const manifests: RepositoryProfileFile[] = [];
    for (const name of rootFiles
      .filter(isRepositoryProfileManifest)
      .slice(0, REPOSITORY_PROFILE_MAX_MANIFESTS)) {
      manifests.push({
        path: name,
        content: (await this.raw(name, defaultBranch, signal)) ?? "",
      });
    }

    const ciDefinitions: RepositoryProfileFile[] = [];
    for (const name of GITLAB_CI_FILES.filter((candidate) =>
      rootFiles.includes(candidate),
    ).slice(0, REPOSITORY_PROFILE_MAX_CI_FILES)) {
      ciDefinitions.push({
        path: name,
        content: (await this.raw(name, defaultBranch, signal)) ?? "",
      });
    }

    return boundRepositoryProfileBundle({
      provider: "gitlab",
      repoPath: this.repoPath,
      defaultBranch,
      description: project.description ?? "",
      readme: readme ?? "",
      manifests,
      lockfiles: rootFiles.filter(isRepositoryProfileLockfile),
      ciDefinitions,
      languages: Object.keys(languages ?? {}),
      // A full page means there may be a second one this never asked for, and
      // the caller has no way to tell that from a root with exactly a hundred
      // files. Recorded as a truncation so the prompt says it out loud.
      truncated:
        treeEntries.length >= GITLAB_ROOT_TREE_PAGE_SIZE
          ? [
              {
                what: `root tree, first ${GITLAB_ROOT_TREE_PAGE_SIZE} entries`,
                originalLength: null,
                keptLength: treeEntries.length,
              },
            ]
          : [],
    });
  }

  private async request(path: string, signal: AbortSignal): Promise<Response | null> {
    const response = await fetch(`${this.baseUrl}/api/v4${path}`, {
      headers: { "PRIVATE-TOKEN": this.token },
      signal,
    });
    // A path this project does not have is the normal answer for a repository
    // without a README or without a CI file, and it is not a reason to fail
    // the whole bundle. Anything else is, because a 401 that read as "no
    // README" would produce a confident proposal about a repository nobody
    // could read.
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `GitLab profile read failed for ${path}: ${response.status} ${response.statusText}`,
      );
    }
    return response;
  }

  private async json<T>(path: string, signal: AbortSignal): Promise<T | null> {
    const response = await this.request(path, signal);
    return response ? ((await response.json()) as T) : null;
  }

  private async raw(
    filePath: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const response = await this.request(
      `/projects/${this.projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`,
      signal,
    );
    return response ? await response.text() : null;
  }
}

/** A profile source for one GitLab project, addressed by its full path exactly
 *  as `createVCSForRepository` addresses one. */
export function createGitLabProfileSource(
  config: { token: string; host: string },
  repoPath: string,
): RepositoryProfileSource {
  return new GitLabProfileSource(config.token, config.host, repoPath);
}
