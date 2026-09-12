import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type { RunRepositoryAccess } from "@shared/contracts";
import type { PullRequest, VCSAdapter } from "../../adapters/vcs/types.js";
import type { ActiveRunOwner } from "../../db/repositories/active-runs.js";
import { scrubForPublication } from "../support/publication-scrub.js";
// Pure and contracts-only, so a static import here drags nothing into the
// bundle that a dynamic one would have kept out.
import { repositoryNotEnabledMessage } from "../support/repository-access.js";
import { isRunControlError } from "../helpers/run-control-error.js";

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
  const { createRepositoryVCS } = await import("../support/vcs-runtime.js");
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

/** Provider mutation phase. Find-before-create and lookup-after-error make a
 * Workflow step replay safe when the provider accepted a request but its
 * response was lost. */
export async function createOrFindWorkflowOwnedPullRequest(input: {
  branchName: string;
  repository: SelectedRepository;
  title: string;
  body: string;
  owner: ActiveRunOwner;
  /** Which repositories this run may open a pull request on, frozen at its
   *  start. */
  repositoryAccess: RunRepositoryAccess;
}): Promise<WorkflowPrLink> {
  "use step";
  const { assertConnectedActiveRunOwner } = await import("../../db/repositories/active-runs.js");
  const { createRepositoryVCS } = await import("../../engine/support/vcs-runtime.js");
  const { mayRunTouchRepository } = await import(
    "../../engine/support/repository-access.js"
  );
  return resolveWorkflowOwnedPullRequest(
    input,
    createRepositoryVCS,
    (repoPath) =>
      mayRunTouchRepository(input.repositoryAccess, {
        provider: input.repository.provider,
        repoPath,
      }),
    () => assertConnectedActiveRunOwner(input.owner),
  );
}
createOrFindWorkflowOwnedPullRequest.maxRetries = 3;

/** Idempotently correlate a provider PR after its exact head and target have
 * been verified. */
export async function recordWorkflowOwnedPullRequest(input: {
  ticketKey: string;
  pr: WorkflowPrLink;
  publishedHeadSha: string;
  targetBranch: string;
}): Promise<void> {
  "use step";
  const { upsertConnectedWorkflowOwnedBranch } = await import(
    "../../db/repositories/runs.js"
  );
  await upsertConnectedWorkflowOwnedBranch({
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
  const { upsertConnectedWorkflowOwnedBranch } = await import(
    "../../db/repositories/runs.js"
  );
  await upsertConnectedWorkflowOwnedBranch({
    ...input,
    prCorrelationPending: true,
  });
}
// Idempotent upsert keyed by (ticketKey, provider, repoPath): a replay writes the
// same row, so retry it like the sibling recordWorkflowOwnedPullRequest step
// instead of failing the run on a transient DB blip.
recordWorkflowOwnedPullRequestIntent.maxRetries = 3;

async function resolveWorkflowOwnedPullRequest(
  input: {
    branchName: string;
    repository: SelectedRepository;
    title: string;
    body?: string;
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
    // One sentence for every catalog refusal in the engine, from one function.
    // Spelling it here by hand is how this site came to say something the
    // promotion and publication guards did not, which left an operator matching
    // three near-identical sentences to three different fixes.
    throw new Error(repositoryNotEnabledMessage("open a pull request on", repo));
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
    // The body carries {{change_summary}}, which is agent-authored prose. This
    // is the last point before the provider sees it. The title is left alone:
    // it is ticket-authored by default, and sentence-granular removal on a
    // one-sentence title could empty it.
    scrubForPublication(input.body ?? ""),
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
  body: string,
  assertProviderMutation?: () => Promise<void>,
): Promise<{ pr: PullRequest; isNew: boolean }> {
  const beforeCreate = await vcs.findPR(branchName);
  if (beforeCreate) return { pr: beforeCreate, isNew: false };

  try {
    await assertProviderMutation?.();
    return { pr: await vcs.createPR(branchName, title, body), isNew: true };
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
