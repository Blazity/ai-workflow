import type { VcsConfig, VcsProviderConfig } from "../../infra/vcs-config.js";
import { GitHubAdapter } from "./github.js";
import { createGitHubProfileSource } from "./github/profile-source.js";
import { GitLabAdapter } from "./gitlab.js";
import { createGitLabProfileSource } from "./gitlab/profile-source.js";
import type { RepositoryProfileSource } from "./repository-profile-source.js";
import type { VCSAdapter } from "./types.js";

export interface RepoTarget {
  repoPath: string;
  baseBranch: string;
}

export function createVCSForRepository(
  vcs: VcsProviderConfig | VcsConfig,
  target: RepoTarget,
): VCSAdapter {
  if (vcs.kind === "gitlab") {
    return new GitLabAdapter({
      token: vcs.token,
      projectId: target.repoPath,
      baseBranch: target.baseBranch,
      host: vcs.host,
    });
  }
  if (vcs.kind !== "github") {
    throw new Error(`Unreachable: VCS kind ${(vcs as VcsProviderConfig | VcsConfig).kind} fell through GitHub branch`);
  }
  const parts = target.repoPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repoPath for GitHub: expected exactly "owner/repo", got "${target.repoPath}"`);
  }
  const [owner, repo] = parts;
  return new GitHubAdapter({
    auth: vcs.auth,
    owner,
    repo,
    baseBranch: target.baseBranch,
  });
}

/**
 * The same provider choice, for reading what a repository says about itself.
 *
 * Here rather than beside the interface, because the interface file must not
 * import its own implementations: every provider module imports that file, and
 * a factory living there would close the loop into a module cycle. This file
 * already exists to make the provider choice once, and this is the same
 * choice.
 */
export function createRepositoryProfileSource(
  vcs: VcsProviderConfig | VcsConfig,
  repoPath: string,
): RepositoryProfileSource {
  if (vcs.kind === "gitlab") {
    return createGitLabProfileSource({ token: vcs.token, host: vcs.host }, repoPath);
  }
  if (vcs.kind !== "github") {
    throw new Error(
      `Unreachable: VCS kind ${(vcs as VcsProviderConfig | VcsConfig).kind} fell through GitHub branch`,
    );
  }
  return createGitHubProfileSource(vcs.auth, repoPath);
}
