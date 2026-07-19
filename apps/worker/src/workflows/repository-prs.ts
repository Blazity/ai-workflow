import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import type { PullRequest, VCSAdapter } from "../adapters/vcs/types.js";
import type { ActiveRunOwner } from "../lib/active-run-owner.js";
import { isRunControlError } from "./run-control-error.js";

export interface WorkflowPrLink {
  provider: SelectedRepository["provider"];
  repoPath: string;
  id: number;
  url: string;
  branch: string;
  isNew: boolean;
}

/** Find-only reconciliation used before publication safety checks. It lets a
 * retry journal a provider side effect that succeeded before a prior ledger
 * write failed, without opening another PR/MR. */
export async function findWorkflowOwnedPullRequestForBranch(input: {
  branchName: string;
  repository: SelectedRepository;
}): Promise<WorkflowPrLink | null> {
  "use step";
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const pr = await createRepositoryVCS({
    provider: input.repository.provider,
    repoPath: input.repository.repoPath,
    baseBranch: input.repository.defaultBranch,
  }).findPR(input.branchName);
  return pr
    ? {
        provider: input.repository.provider,
        repoPath: input.repository.repoPath,
        ...pr,
        isNew: false,
      }
    : null;
}
findWorkflowOwnedPullRequestForBranch.maxRetries = 3;

/** Provider-only PR phase used by durable publication. Database correlation
 * is deliberately separate so an accepted provider side effect can be
 * journaled before any secondary write is attempted. */
export async function createOrFindWorkflowOwnedPullRequest(input: {
  branchName: string;
  repository: SelectedRepository;
  title: string;
  owner: ActiveRunOwner;
}): Promise<WorkflowPrLink> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const { isRepoAllowed } = await import("../lib/repo-allowlist.js");
  return resolveWorkflowOwnedPullRequest(
    input,
    createRepositoryVCS,
    isRepoAllowed,
    () => assertActiveRunOwner(getDb(), input.owner),
  );
}
createOrFindWorkflowOwnedPullRequest.maxRetries = 3;

/** Idempotent correlation phase run after the publication ledger contains the
 * provider PR result. Safe to repeat when a prior branch-record write failed. */
export async function recordWorkflowOwnedPullRequest(input: {
  ticketKey: string;
  pr: WorkflowPrLink;
  publishedHeadSha: string;
  targetBranch: string;
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
    targetBranch: input.targetBranch,
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
  targetBranch: string;
}): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { upsertWorkflowOwnedBranch } = await import(
    "../db/queries/workflow-owned-branches.js"
  );
  await upsertWorkflowOwnedBranch(getDb(), {
    ...input,
    prCorrelationPending: true,
  });
}
recordWorkflowOwnedPullRequestIntent.maxRetries = 0;

export async function prepareSelectedRepositoryBranches(
  ticketKey: string,
  branchName: string,
  repositories: SelectedRepository[],
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
  const { upsertWorkflowOwnedBranch } = await import("../db/queries/workflow-owned-branches.js");
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const { isRepoAllowed } = await import("../lib/repo-allowlist.js");
  const db = getDb();

  for (const repo of repositories) {
    if (!isRepoAllowed(repo.repoPath)) {
      throw new Error(`Refusing to branch ${repo.repoPath}: not in AGENT_ALLOWED_REPOS`);
    }
    if (repo.workflowOwnedBranch) continue;

    const vcs = createRepositoryVCS({
      provider: repo.provider,
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    });
    await assertActiveRunOwner(db, owner);
    await vcs.createBranch(branchName, repo.defaultBranch);

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
  owner: ActiveRunOwner;
}): Promise<WorkflowPrLink[]> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
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
      () => assertActiveRunOwner(db, input.owner),
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
  assertProviderMutation?: () => Promise<void>,
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
  const { pr, isNew } = await createOrFindPullRequest(
    vcs,
    branchName,
    input.title,
    assertProviderMutation,
  );
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
  assertProviderMutation?: () => Promise<void>,
): Promise<{ pr: PullRequest; isNew: boolean }> {
  const beforeCreate = await vcs.findPR(branchName);
  if (beforeCreate) return { pr: beforeCreate, isNew: false };

  try {
    await assertProviderMutation?.();
    return { pr: await vcs.createPR(branchName, title, ""), isNew: true };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    // Creation can succeed remotely and still time out before the response
    // reaches us. Reconcile every error before surfacing it to the durable
    // publication retry loop so a replay never creates a duplicate PR/MR.
    const afterCreate = await vcs.findPR(branchName);
    if (afterCreate) return { pr: afterCreate, isNew: false };
    throw err;
  }
}
