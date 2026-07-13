import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import type { PullRequest, VCSAdapter } from "../adapters/vcs/types.js";

export interface WorkflowPrLink {
  provider: SelectedRepository["provider"];
  repoPath: string;
  id: number;
  url: string;
  branch: string;
  isNew: boolean;
}

export async function prepareSelectedRepositoryBranches(
  ticketKey: string,
  branchName: string,
  repositories: SelectedRepository[],
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { upsertWorkflowOwnedBranch } = await import("../db/queries/workflow-owned-branches.js");
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const { isRepoAllowed } = await import("../lib/repo-allowlist.js");
  const db = getDb();

  for (const repo of repositories) {
    if (!isRepoAllowed(repo.repoPath)) {
      throw new Error(`Refusing to branch ${repo.repoPath}: not in AGENT_ALLOWED_REPOS`);
    }
    if (repo.workflowOwnedBranch) continue;

    await createRepositoryVCS({
      provider: repo.provider,
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    }).createBranch(branchName, repo.defaultBranch);

    await upsertWorkflowOwnedBranch(db, {
      ticketKey,
      provider: repo.provider,
      repoPath: repo.repoPath,
      branchName,
    });
  }
}
prepareSelectedRepositoryBranches.maxRetries = 0;

export async function createOrUseWorkflowOwnedPullRequestsForRepos(input: {
  ticketKey: string;
  branchName: string;
  repositories: SelectedRepository[];
  title: string;
}): Promise<WorkflowPrLink[]> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { upsertWorkflowOwnedBranch } = await import("../db/queries/workflow-owned-branches.js");
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const { isRepoAllowed } = await import("../lib/repo-allowlist.js");
  const db = getDb();
  const prs: WorkflowPrLink[] = [];

  for (const repo of input.repositories) {
    if (!isRepoAllowed(repo.repoPath)) {
      throw new Error(`Refusing to open a PR on ${repo.repoPath}: not in AGENT_ALLOWED_REPOS`);
    }
    const existing = repo.workflowOwnedBranch?.pr;
    if (existing) {
      prs.push({
        provider: repo.provider,
        repoPath: repo.repoPath,
        id: existing.id,
        url: existing.url,
        branch: existing.branch,
        isNew: false,
      });
      continue;
    }

    const branchName = repo.workflowOwnedBranch?.branchName ?? input.branchName;
    const vcs = createRepositoryVCS({
      provider: repo.provider,
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    });
    const { pr, isNew } = await createOrFindPullRequest(vcs, branchName, input.title);

    await upsertWorkflowOwnedBranch(db, {
      ticketKey: input.ticketKey,
      provider: repo.provider,
      repoPath: repo.repoPath,
      branchName,
      pr: {
        id: pr.id,
        url: pr.url,
        branch: pr.branch,
      },
    });

    prs.push({
      provider: repo.provider,
      repoPath: repo.repoPath,
      id: pr.id,
      url: pr.url,
      branch: pr.branch,
      isNew,
    });
  }

  return prs;
}
createOrUseWorkflowOwnedPullRequestsForRepos.maxRetries = 0;

async function createOrFindPullRequest(
  vcs: VCSAdapter,
  branchName: string,
  title: string,
): Promise<{ pr: PullRequest; isNew: boolean }> {
  try {
    return { pr: await vcs.createPR(branchName, title, ""), isNew: true };
  } catch (err) {
    if (!isAlreadyOpenPullRequestError(err)) throw err;
    const existing = await vcs.findPR(branchName);
    if (!existing) throw err;
    return { pr: existing, isNew: false };
  }
}

function isAlreadyOpenPullRequestError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already (exists|open)|pull request already exists|merge request already exists/i.test(message);
}
