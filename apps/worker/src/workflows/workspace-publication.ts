import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import type { PullRequestHead } from "../adapters/vcs/types.js";
import type { HumanDecision } from "../lib/human-decisions-memory.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import {
  publishTrustedWorkspaceFromSandbox,
  type TrustedWorkspacePushResult,
} from "../sandbox/trusted-workspace-publisher.js";
import { writeHumanDecisionsMemory } from "../sandbox/write-human-decisions-memory.js";
import {
  createOrFindWorkflowOwnedPullRequest,
  findWorkflowOwnedPullRequestForBranch,
  recordWorkflowOwnedPullRequest,
  recordWorkflowOwnedPullRequestIntent,
  type WorkflowPrLink,
} from "./repository-prs.js";
import { isRunControlError } from "./run-control-error.js";
import {
  assertOpenSourcePullRequest,
  isSourcePullRequestRepository,
  type SourcePullRequestIdentity,
} from "./source-pull-request.js";

export interface FinalizedBranch {
  provider: SelectedRepository["provider"];
  repoPath: string;
  branchName: string;
  defaultBranch: string;
  expectedHead: string;
  pushedHead: string;
}

export type WorkspacePublicationResult =
  | {
      status: "finalized";
      repositories: FinalizedBranch[];
      prs: [];
      pushResult?: TrustedWorkspacePushResult;
    }
  | {
      status: "published";
      repositories: FinalizedBranch[];
      prs: WorkflowPrLink[];
      pushResult?: TrustedWorkspacePushResult;
    }
  | {
      status: "failed";
      reason: string;
      repositories: FinalizedBranch[];
      prs: WorkflowPrLink[];
      pushResult?: TrustedWorkspacePushResult;
    };

/**
 * Finalize writes durable human decisions, verifies the mutable source PR,
 * then publishes every changed repository with exact leases. Workflow step
 * durability is the retry mechanism; no parallel publication ledger exists.
 */
export async function finalizeWorkspacePublication(input: {
  runId: string;
  subjectKey: string;
  ownerToken: string;
  sandboxId: string;
  ticketKey: string;
  workspaceManifest: WorkspaceManifest;
  clarifications?: HumanDecision[];
  sourcePullRequest?: SourcePullRequestIdentity;
}): Promise<WorkspacePublicationResult> {
  if (input.clarifications?.length) {
    await writeHumanDecisionsMemory(input.sandboxId, input.ticketKey, input.clarifications);
  }

  if (input.sourcePullRequest) {
    try {
      assertOpenSourcePullRequest(
        input.sourcePullRequest,
        await verifySourcePullRequestStep(input.sourcePullRequest),
      );
    } catch (error) {
      if (isRunControlError(error)) throw error;
      return failed(error);
    }
  }

  let pushResult: TrustedWorkspacePushResult;
  try {
    pushResult = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: input.sandboxId,
      workspaceManifest: input.workspaceManifest,
      subjectKey: input.subjectKey,
      ownerToken: input.ownerToken,
      runId: input.runId,
      ...(input.sourcePullRequest ? { sourcePullRequest: input.sourcePullRequest } : {}),
    });
  } catch (error) {
    if (isRunControlError(error)) throw error;
    return failed(error);
  }

  const repositories = finalizedBranchesFromPush(pushResult);
  if (!pushResult.pushed) {
    return {
      status: "failed",
      reason: pushResult.error ?? "workspace push failed",
      repositories,
      prs: [],
      pushResult,
    };
  }
  return { status: "finalized", repositories, prs: [], pushResult };
}

/**
 * Opens or reuses PRs for the exact branch heads emitted by Finalize. Every
 * mutable provider value is checked before ownership is persisted.
 */
export async function openPullRequestsForPublication(input: {
  repositories: FinalizedBranch[];
  runId: string;
  subjectKey: string;
  ownerToken: string;
  ticketKey: string;
  title: string;
  sourcePullRequest?: SourcePullRequestIdentity;
}): Promise<WorkspacePublicationResult> {
  if (input.repositories.length === 0) {
    return failed("finalized publication produced no changed repository to open");
  }

  const expectedSource = input.sourcePullRequest
    ? sourcePullRequestAfterPublication(input.sourcePullRequest, input.repositories)
    : null;
  if (expectedSource) {
    try {
      assertOpenSourcePullRequest(
        expectedSource,
        await verifySourcePullRequestStep(expectedSource),
      );
    } catch (error) {
      if (isRunControlError(error)) throw error;
      return failed(error, input.repositories);
    }
  }

  const prs: WorkflowPrLink[] = [];
  for (const repository of input.repositories) {
    const selected = selectedRepository(repository);
    const isSourceRepository = Boolean(
      expectedSource && isSourcePullRequestRepository(expectedSource, repository),
    );
    try {
      let pr = await findWorkflowOwnedPullRequestForBranch({
        branchName: repository.branchName,
        repository: selected,
      });

      if (isSourceRepository && (!pr || pr.id !== expectedSource!.prId)) {
        const observed = pr ? `#${pr.id}` : "no open PR/MR";
        throw new Error(
          `exact source PR/MR #${expectedSource!.prId} is unavailable; found ${observed}`,
        );
      }

      assertFinalizedBranchHead(
        repository,
        await verifyFinalizedBranchHeadStep(repository),
      );

      if (!pr) {
        // Persist the exact branch intent only after proving the remote still
        // equals Finalize's output. This lets an immediate webhook correlate
        // provider creation without claiming a stale or foreign branch.
        await recordWorkflowOwnedPullRequestIntent({
          ticketKey: input.ticketKey,
          provider: repository.provider,
          repoPath: repository.repoPath,
          branchName: repository.branchName,
          publishedHeadSha: repository.pushedHead,
          targetBranch: repository.defaultBranch,
        });
        pr = await createOrFindWorkflowOwnedPullRequest({
          branchName: repository.branchName,
          repository: selected,
          title: input.title,
          owner: {
            subjectKey: input.subjectKey,
            ownerToken: input.ownerToken,
            runId: input.runId,
          },
        });
      }

      const currentPr = isSourceRepository
        ? await verifySourcePullRequestStep(expectedSource!)
        : await verifyPullRequestStep({
            provider: repository.provider,
            repoPath: repository.repoPath,
            prId: pr.id,
            targetBranch: repository.defaultBranch,
          });
      assertOpenPublicationPullRequest(
        {
          provider: repository.provider,
          repoPath: repository.repoPath,
          prId: pr.id,
          headSha: repository.pushedHead,
          targetBranch: repository.defaultBranch,
        },
        currentPr,
      );

      await recordWorkflowOwnedPullRequest({
        ticketKey: input.ticketKey,
        pr,
        publishedHeadSha: repository.pushedHead,
        targetBranch: repository.defaultBranch,
      });
      prs.push(pr);
    } catch (error) {
      if (isRunControlError(error)) throw error;
      return failed(error, input.repositories, prs);
    }
  }

  return { status: "published", repositories: input.repositories, prs };
}

async function verifySourcePullRequestStep(
  input: SourcePullRequestIdentity,
): Promise<PullRequestHead> {
  "use step";
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  return createRepositoryVcsRuntime({
    provider: input.provider,
    repoPath: input.repoPath,
    baseBranch: input.baseRef,
  }).vcs.getPRHead(input.prId);
}
verifySourcePullRequestStep.maxRetries = 3;

async function verifyPullRequestStep(input: {
  provider: SelectedRepository["provider"];
  repoPath: string;
  prId: number;
  targetBranch: string;
}): Promise<PullRequestHead> {
  "use step";
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  return createRepositoryVcsRuntime({
    provider: input.provider,
    repoPath: input.repoPath,
    baseBranch: input.targetBranch,
  }).vcs.getPRHead(input.prId);
}
verifyPullRequestStep.maxRetries = 3;

async function verifyFinalizedBranchHeadStep(repository: FinalizedBranch): Promise<string> {
  "use step";
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  return createRepositoryVcsRuntime({
    provider: repository.provider,
    repoPath: repository.repoPath,
    baseBranch: repository.defaultBranch,
  }).vcs.getBranchSha(repository.branchName);
}
verifyFinalizedBranchHeadStep.maxRetries = 3;

function assertFinalizedBranchHead(repository: FinalizedBranch, currentHead: string): void {
  if (currentHead === repository.pushedHead) return;
  throw new Error(
    `finalized branch moved for ${repository.provider}:${repository.repoPath}: ` +
      `expected ${repository.pushedHead}, current head is ${currentHead}`,
  );
}

function assertOpenPublicationPullRequest(
  input: {
    provider: SelectedRepository["provider"];
    repoPath: string;
    prId: number;
    headSha: string;
    targetBranch: string;
  },
  current: PullRequestHead,
): void {
  const identity = `${input.provider}:${input.repoPath} #${input.prId}`;
  if (current.headSha !== input.headSha) {
    throw new Error(
      `stale PR/MR head for ${identity}: published at ${input.headSha}, current head is ${current.headSha}`,
    );
  }
  if (current.baseRef !== input.targetBranch) {
    throw new Error(
      `stale PR/MR target for ${identity}: published for ${input.targetBranch}, current target is ${current.baseRef}`,
    );
  }
  if (current.state !== "open") {
    throw new Error(
      `publication PR/MR ${identity} is ${current.state}; publication requires it to be open`,
    );
  }
}

function sourcePullRequestAfterPublication(
  source: SourcePullRequestIdentity,
  repositories: FinalizedBranch[],
): SourcePullRequestIdentity {
  const repository = repositories.find((candidate) =>
    isSourcePullRequestRepository(source, candidate),
  );
  return { ...source, headSha: repository?.pushedHead ?? source.headSha };
}

function finalizedBranchesFromPush(
  pushResult: TrustedWorkspacePushResult,
): FinalizedBranch[] {
  return pushResult.repositories.flatMap((repository) =>
    repository.changed && repository.pushed && repository.expectedHead && repository.pushedHead
      ? [
          {
            provider: repository.provider,
            repoPath: repository.repoPath,
            branchName: repository.branchName,
            defaultBranch: repository.defaultBranch,
            expectedHead: repository.expectedHead,
            pushedHead: repository.pushedHead,
          },
        ]
      : [],
  );
}

function selectedRepository(repository: FinalizedBranch): SelectedRepository {
  return {
    provider: repository.provider,
    repoPath: repository.repoPath,
    defaultBranch: repository.defaultBranch,
    selectedRationale: "finalized workflow publication",
    workflowOwnedBranch: { branchName: repository.branchName },
  };
}

function failed(
  error: unknown,
  repositories: FinalizedBranch[] = [],
  prs: WorkflowPrLink[] = [],
): WorkspacePublicationResult {
  return {
    status: "failed",
    reason: error instanceof Error ? error.message : String(error),
    repositories,
    prs,
  };
}
