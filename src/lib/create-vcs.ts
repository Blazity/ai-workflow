import { getVcsConfig } from "../../env.js";
import { GitHubAdapter } from "../adapters/vcs/github.js";
import { GitLabAdapter } from "../adapters/vcs/gitlab.js";
import type { VCSAdapter } from "../adapters/vcs/types.js";

export function createVCS(): VCSAdapter {
  const vcs = getVcsConfig();
  if (vcs.kind === "gitlab") {
    return new GitLabAdapter({
      token: vcs.token,
      projectId: vcs.repoPath,
      baseBranch: vcs.baseBranch,
      host: vcs.host,
    });
  }
  const parts = vcs.repoPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repoPath for GitHub: expected exactly "owner/repo", got "${vcs.repoPath}"`);
  }
  const [owner, repo] = parts;
  return new GitHubAdapter({
    token: vcs.token,
    owner,
    repo,
    baseBranch: vcs.baseBranch,
  });
}
