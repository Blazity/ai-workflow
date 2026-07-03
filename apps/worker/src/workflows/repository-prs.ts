import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";

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
  const { getVcsProviderConfig } = await import("../../env.js");
  const { createVCSForRepository } = await import("../lib/create-vcs.js");
  const db = getDb();

  for (const repo of repositories) {
    if (repo.workflowOwnedBranch) continue;
    const vcsConfig = getVcsProviderConfig(repo.provider);

    await createVCSForRepository(vcsConfig, {
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
  const { getVcsProviderConfig } = await import("../../env.js");
  const { createVCSForRepository } = await import("../lib/create-vcs.js");
  const db = getDb();
  const prs: WorkflowPrLink[] = [];

  for (const repo of input.repositories) {
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
    const vcsConfig = getVcsProviderConfig(repo.provider);
    const pr = await createVCSForRepository(vcsConfig, {
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    }).createPR(branchName, input.title, "");

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
      isNew: true,
    });
  }

  return prs;
}
createOrUseWorkflowOwnedPullRequestsForRepos.maxRetries = 0;
