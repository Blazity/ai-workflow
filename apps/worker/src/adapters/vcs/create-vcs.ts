import { getVcsConfig, type VcsConfig, type VcsProviderConfig } from "../../infra/vcs-config.js";
import { GitHubAdapter } from "./github.js";
import { GitLabAdapter } from "./gitlab.js";
import type { VCSAdapter } from "./types.js";

export function createVCS(): VCSAdapter {
  const vcs = getVcsConfig();
  return createVCSForRepository(vcs, {
    repoPath: vcs.repoPath,
    baseBranch: vcs.baseBranch,
  });
}

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
