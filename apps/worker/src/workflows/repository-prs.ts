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

/** Provider-only PR phase used by durable publication. Database correlation
 * is deliberately separate so an accepted provider side effect can be
 * journaled before any secondary write is attempted. */
export async function createOrFindWorkflowOwnedPullRequest(input: {
  branchName: string;
  repository: SelectedRepository;
  title: string;
}): Promise<WorkflowPrLink> {
  "use step";
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const { isRepoAllowed } = await import("../lib/repo-allowlist.js");
  return resolveWorkflowOwnedPullRequest(input, createRepositoryVCS, isRepoAllowed);
}
createOrFindWorkflowOwnedPullRequest.maxRetries = 3;

/** Idempotent correlation phase run after the publication ledger contains the
 * provider PR result. Safe to repeat when a prior branch-record write failed. */
export async function recordWorkflowOwnedPullRequest(input: {
  ticketKey: string;
  pr: WorkflowPrLink;
  publishedHeadSha: string;
}): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { upsertWorkflowOwnedBranch } = await import(
    "../db/queries/workflow-owned-branches.js"
  );
  await upsertWorkflowOwnedBranch(getDb(), {
    ticketKey: input.ticketKey,
    provider: input.pr.provider,
    repoPath: input.pr.repoPath,
    branchName: input.pr.branch,
    publishedHeadSha: input.publishedHeadSha,
    pr: {
      id: input.pr.id,
      url: input.pr.url,
      branch: input.pr.branch,
    },
  });
}
recordWorkflowOwnedPullRequest.maxRetries = 3;

/** Persist the exact trusted branch/head before asking the provider to create
 * a PR. A concurrent PR-created webhook can then be held durably until the
 * provider-assigned PR id is correlated by recordWorkflowOwnedPullRequest. */
export async function recordWorkflowOwnedPullRequestIntent(input: {
  ticketKey: string;
  provider: SelectedRepository["provider"];
  repoPath: string;
  branchName: string;
  publishedHeadSha: string;
}): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { upsertWorkflowOwnedBranch } = await import(
    "../db/queries/workflow-owned-branches.js"
  );
  await upsertWorkflowOwnedBranch(getDb(), input, { replacePullRequest: true });
}
recordWorkflowOwnedPullRequestIntent.maxRetries = 0;

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
    const result = await resolveWorkflowOwnedPullRequest(
      { branchName: input.branchName, repository: repo, title: input.title },
      createRepositoryVCS,
      isRepoAllowed,
    );

    await upsertWorkflowOwnedBranch(db, {
      ticketKey: input.ticketKey,
      provider: repo.provider,
      repoPath: repo.repoPath,
      branchName: result.branch,
      pr: {
        id: result.id,
        url: result.url,
        branch: result.branch,
      },
    });

    prs.push(result);
  }

  return prs;
}
createOrUseWorkflowOwnedPullRequestsForRepos.maxRetries = 0;

async function resolveWorkflowOwnedPullRequest(
  input: {
    branchName: string;
    repository: SelectedRepository;
    title: string;
  },
  createVcs: (input: {
    provider: SelectedRepository["provider"];
    repoPath: string;
    baseBranch: string;
  }) => VCSAdapter,
  isAllowed: (repoPath: string) => boolean,
): Promise<WorkflowPrLink> {
  const repo = input.repository;
  if (!isAllowed(repo.repoPath)) {
    throw new Error(`Refusing to open a PR on ${repo.repoPath}: not in AGENT_ALLOWED_REPOS`);
  }
  const existing = repo.workflowOwnedBranch?.pr;
  if (existing) {
    return {
      provider: repo.provider,
      repoPath: repo.repoPath,
      id: existing.id,
      url: existing.url,
      branch: existing.branch,
      isNew: false,
    };
  }

  const branchName = repo.workflowOwnedBranch?.branchName ?? input.branchName;
  const vcs = createVcs({
    provider: repo.provider,
    repoPath: repo.repoPath,
    baseBranch: repo.defaultBranch,
  });
  const { pr, isNew } = await createOrFindPullRequest(vcs, branchName, input.title);
  return {
    provider: repo.provider,
    repoPath: repo.repoPath,
    id: pr.id,
    url: pr.url,
    branch: pr.branch,
    isNew,
  };
}

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
