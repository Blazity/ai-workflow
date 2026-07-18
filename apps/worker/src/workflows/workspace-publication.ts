import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import type { HumanDecision } from "../lib/human-decisions-memory.js";
import {
  publishTrustedWorkspaceFromSandbox,
  type TrustedWorkspacePushResult,
} from "../sandbox/trusted-workspace-publisher.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import { writeHumanDecisionsMemory } from "../sandbox/write-human-decisions-memory.js";
import type {
  PublicationAttemptRecord,
  PublicationRepositoryRecord,
} from "../publication/store.js";
import {
  createOrFindWorkflowOwnedPullRequest,
  findWorkflowOwnedPullRequestForBranch,
  recordWorkflowOwnedPullRequest,
  recordWorkflowOwnedPullRequestIntent,
  type WorkflowPrLink,
} from "./repository-prs.js";
import {
  durationBudgetFailure,
  RunBudgetError,
  type RunBudgetObservation,
} from "./run-budget.js";

export interface FinalizedBranch {
  provider: SelectedRepository["provider"];
  repoPath: string;
  branchName: string;
  expectedHead: string;
  pushedHead: string;
}

export type WorkspacePublicationResult =
  | {
      status: "finalized";
      attemptId: string;
      repositories: FinalizedBranch[];
      prs: [];
      pushResult?: TrustedWorkspacePushResult;
    }
  | {
      status: "published";
      attemptId: string;
      repositories: FinalizedBranch[];
      prs: WorkflowPrLink[];
      pushResult?: TrustedWorkspacePushResult;
    }
  | {
      status: "failed";
      attemptId: string;
      reason: string;
      repositories: FinalizedBranch[];
      prs: WorkflowPrLink[];
      pushResult?: TrustedWorkspacePushResult;
    };

type RecoverablePublicationResult = {
  status: "recoverable";
  attemptId: string;
  reason: string;
  repositories: FinalizedBranch[];
  prs: WorkflowPrLink[];
};

type OpenPullRequestsAttemptResult =
  | WorkspacePublicationResult
  | RecoverablePublicationResult;

export interface PublicationRecoveryOptions {
  observeBudget?: () => Promise<RunBudgetObservation>;
}

export async function finalizeWorkspacePublication(input: {
  runId: string;
  blockId: string;
  sandboxId: string;
  ticketKey: string;
  workspaceManifest: WorkspaceManifest;
  clarifications?: HumanDecision[];
  sourcePullRequest?: {
    provider: SelectedRepository["provider"];
    repoPath: string;
    prId: number;
    headSha: string;
  };
}): Promise<WorkspacePublicationResult> {
  const creation = await createPublicationAttemptStep({
    runId: input.runId,
    blockId: input.blockId,
    workspaceManifest: input.workspaceManifest,
  });

  let resumingPush = false;
  if (!creation.created) {
    if (creation.attempt.status === "pushing") {
      let reconciled: Awaited<ReturnType<typeof reconcilePushingPublicationStep>>;
      try {
        reconciled = await reconcilePushingPublicationStep(creation.attempt);
      } catch (error) {
        return terminalPublicationFailure(
          creation.attempt.id,
          exhaustedPublicationReason(error),
          creation.attempt.repositories,
        );
      }
      if (reconciled.unresolvedReason) {
        return terminalPublicationFailure(
          reconciled.attempt.id,
          exhaustedPublicationReason(reconciled.unresolvedReason),
          reconciled.attempt.repositories,
        );
      }
      if (!reconciled.resumePush) return replayedFinalizeResult(reconciled.attempt);
      resumingPush = true;
    } else if (creation.attempt.status !== "preflighting") {
      return replayedFinalizeResult(creation.attempt);
    }
  }
  const attemptId = creation.attempt.id;

  if (!resumingPush) {
    // This pre-existing behavior remains intentionally separate from AIW-100's
    // publication policy. It still runs before the clean-tree preflight/push.
    if (input.clarifications && input.clarifications.length > 0) {
      await writeHumanDecisionsMemory(input.sandboxId, input.ticketKey, input.clarifications);
    }

    if (input.sourcePullRequest) {
      try {
        const currentHead = await verifyPullRequestHeadStep(input.sourcePullRequest);
        assertPullRequestHead(input.sourcePullRequest, currentHead);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await failPublicationStep({
          attemptId,
          reason,
          repository: {
            provider: input.sourcePullRequest.provider,
            repoPath: input.sourcePullRequest.repoPath,
          },
        });
        return failedResult(attemptId, reason, creation.attempt.repositories, []);
      }
    }

    await markPublicationPushingStep(attemptId);
  }

  let pushResult: TrustedWorkspacePushResult;
  try {
    pushResult = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: input.sandboxId,
      publicationAttemptId: attemptId,
      workspaceManifest: input.workspaceManifest,
    });
    await recordPushOutcomeStep(attemptId, pushResult);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    let latest: PublicationAttemptRecord | null;
    try {
      latest = await loadPublicationAttemptStep(attemptId);
    } catch (loadError) {
      return terminalPublicationFailure(
        attemptId,
        exhaustedPublicationReason(loadError, reason),
        creation.attempt.repositories,
      );
    }
    if (latest?.status === "pushing") {
      try {
        const reconciled = await reconcilePushingPublicationStep(latest);
        if (!reconciled.unresolvedReason && !reconciled.resumePush) {
          return replayedFinalizeResult(reconciled.attempt);
        }
        return terminalPublicationFailure(
          attemptId,
          exhaustedPublicationReason(reconciled.unresolvedReason ?? reason),
          reconciled.attempt.repositories,
        );
      } catch (reconcileError) {
        return terminalPublicationFailure(
          attemptId,
          exhaustedPublicationReason(reconcileError, reason),
          latest.repositories,
        );
      }
    }
    if (latest) return replayedFinalizeResult(latest);
    return terminalPublicationFailure(
      attemptId,
      exhaustedPublicationReason(reason),
      creation.attempt.repositories,
    );
  }

  if (!pushResult.pushed) {
    const reason = pushResult.error ?? "workspace push failed";
    return {
      ...failedResult(attemptId, reason, recordsFromPush(pushResult), []),
      pushResult,
    };
  }

  return {
    status: "finalized",
    attemptId,
    repositories: finalizedBranchesFromPush(pushResult),
    prs: [],
  };
}

async function terminalPublicationFailure(
  attemptId: string,
  reason: string,
  repositories: PublicationRepositoryRecord[],
): Promise<WorkspacePublicationResult> {
  const concurrent = await failPublicationStep({ attemptId, reason });
  return concurrent
    ? replayedFinalizeResult(concurrent)
    : failedResult(attemptId, reason, repositories, []);
}

function exhaustedPublicationReason(error: unknown, priorReason?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = priorReason && priorReason !== message ? `${priorReason}; ${message}` : message;
  return `publication retries exhausted: ${detail}`;
}

/**
 * Phase two: consume a durable successful Finalize attempt. There is no
 * sandbox id and no push call in this API by construction.
 */
export async function openPullRequestsForPublication(
  input: {
    attemptId: string;
    runId: string;
    ticketKey: string;
    title: string;
  },
  options: PublicationRecoveryOptions = {},
): Promise<WorkspacePublicationResult> {
  let retryIndex = 0;
  for (;;) {
    const result = await openPullRequestsForPublicationOnce(input);
    if (result.status !== "recoverable") return result;
    await waitForPublicationRecovery(retryIndex++, options.observeBudget);
  }
}

async function openPullRequestsForPublicationOnce(input: {
  attemptId: string;
  runId: string;
  ticketKey: string;
  title: string;
}): Promise<OpenPullRequestsAttemptResult> {
  let attempt: PublicationAttemptRecord | null;
  try {
    attempt = await loadPublicationAttemptStep(input.attemptId);
  } catch (error) {
    return recoverableResult(
      input.attemptId,
      error instanceof Error ? error.message : String(error),
      [],
      [],
    );
  }
  if (!attempt) {
    return failedResult(input.attemptId, "publication attempt not found", [], []);
  }
  if (attempt.runId !== input.runId) {
    return failedResult(
      attempt.id,
      `publication attempt belongs to run ${attempt.runId}, not ${input.runId}`,
      attempt.repositories,
      prLinksFromAttempt(attempt),
    );
  }
  if (attempt.status === "published") return publishedResult(attempt);
  if (attempt.status !== "finalized" && attempt.status !== "creating_prs") {
    return failedResult(
      attempt.id,
      attempt.failure ?? `publication attempt is ${attempt.status}, not finalized`,
      attempt.repositories,
      prLinksFromAttempt(attempt),
    );
  }

  if (attempt.status === "finalized") {
    try {
      await markPublicationCreatingPrsStep(attempt.id);
    } catch (error) {
      return recoverableResult(
        attempt.id,
        error instanceof Error ? error.message : String(error),
        attempt.repositories,
        prLinksFromAttempt(attempt),
      );
    }
  }

  const prs = prLinksFromAttempt(attempt);
  for (const repository of attempt.repositories.filter(
    (repo) => repo.changed && repo.pushedHead !== null,
  )) {
    let pr = repository.pr ? prLinkFromRepository(repository) : null;
    if (!pr) {
      try {
        pr = await findWorkflowOwnedPullRequestForBranch({
          branchName: repository.branchName,
          repository: selectedRepositoryFromAttempt(repository),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return isDeterministicProviderFailure(err)
          ? terminalOpenPullRequestFailure(attempt, repository, reason, prs)
          : recoverableOpenPullRequestFailure(attempt, repository, reason, prs);
      }
      if (pr) {
        if (!prs.some((existing) => sameRepository(existing, pr!))) prs.push(pr);
        try {
          await recordPullRequestStep(attempt.id, pr);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return recoverableOpenPullRequestFailure(attempt, repository, reason, prs);
        }
      }
    }

    let currentBranchHead: string;
    try {
      currentBranchHead = await verifyFinalizedBranchHeadStep(repository);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return isDeterministicProviderFailure(err)
        ? terminalOpenPullRequestFailure(attempt, repository, reason, prs)
        : recoverableOpenPullRequestFailure(attempt, repository, reason, prs);
    }

    try {
      assertFinalizedBranchHead(repository, currentBranchHead);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return terminalOpenPullRequestFailure(attempt, repository, reason, prs);
    }

    if (!pr) {
      try {
        await recordWorkflowOwnedPullRequestIntent({
          ticketKey: input.ticketKey,
          provider: repository.provider,
          repoPath: repository.repoPath,
          branchName: repository.branchName,
          publishedHeadSha: repository.pushedHead!,
          targetBranch: repository.defaultBranch,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return recoverableOpenPullRequestFailure(attempt, repository, reason, prs);
      }
    }

    try {
      pr ??= await createOrFindWorkflowOwnedPullRequest({
        branchName: repository.branchName,
        repository: selectedRepositoryFromAttempt(repository),
        title: input.title,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return isDeterministicProviderFailure(err)
        ? terminalOpenPullRequestFailure(attempt, repository, reason, prs)
        : recoverableOpenPullRequestFailure(attempt, repository, reason, prs);
    }

    if (!prs.some((existing) => sameRepository(existing, pr))) {
      prs.push(pr);
      try {
        await recordPullRequestStep(attempt.id, pr);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return recoverableOpenPullRequestFailure(attempt, repository, reason, prs);
      }
    }
    let currentPrHead: string;
    try {
      currentPrHead = await verifyPullRequestHeadStep({
        provider: repository.provider,
        repoPath: repository.repoPath,
        prId: pr.id,
        headSha: repository.pushedHead!,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return isDeterministicProviderFailure(err)
        ? terminalOpenPullRequestFailure(attempt, repository, reason, prs)
        : recoverableOpenPullRequestFailure(attempt, repository, reason, prs);
    }

    try {
      assertPullRequestHead(
        {
          provider: repository.provider,
          repoPath: repository.repoPath,
          prId: pr.id,
          headSha: repository.pushedHead!,
        },
        currentPrHead,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return terminalOpenPullRequestFailure(attempt, repository, reason, prs);
    }

    try {
      await recordWorkflowOwnedPullRequest({
        ticketKey: input.ticketKey,
        pr,
        publishedHeadSha: repository.pushedHead!,
        targetBranch: repository.defaultBranch,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return recoverableOpenPullRequestFailure(attempt, repository, reason, prs);
    }
  }

  if (prs.length === 0) {
    const reason = "finalized publication produced no changed repository to open";
    await failPublicationStep({ attemptId: attempt.id, reason });
    return failedResult(attempt.id, reason, attempt.repositories, []);
  }

  try {
    await markPublicationPublishedStep(attempt.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return recoverableResult(attempt.id, reason, attempt.repositories, prs);
  }
  let reloaded: PublicationAttemptRecord | null;
  try {
    reloaded = await loadPublicationAttemptStep(attempt.id);
  } catch (error) {
    return recoverableResult(
      attempt.id,
      error instanceof Error ? error.message : String(error),
      attempt.repositories,
      prs,
    );
  }
  if (!reloaded) {
    return failedResult(
      attempt.id,
      "publication attempt disappeared after the published transition",
      attempt.repositories,
      prs,
    );
  }
  if (reloaded.status === "published") return publishedResult(reloaded);
  if (reloaded.status === "creating_prs" || reloaded.status === "finalized") {
    return recoverableResult(
      reloaded.id,
      `publication attempt is ${reloaded.status}, not published`,
      reloaded.repositories,
      prs,
    );
  }
  return failedResult(
    reloaded.id,
    reloaded.failure ?? `publication attempt is ${reloaded.status}, not published`,
    reloaded.repositories,
    prs,
  );
}

function isDeterministicProviderFailure(error: unknown): boolean {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    headers?: Headers | Record<string, unknown>;
    response?: {
      status?: unknown;
      statusCode?: unknown;
      headers?: Headers | Record<string, unknown>;
    };
    cause?: { response?: { status?: unknown; statusCode?: unknown } };
  };
  const status = [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
    candidate.response?.statusCode,
    candidate.cause?.response?.status,
    candidate.cause?.response?.statusCode,
  ].find((value): value is number => typeof value === "number");
  const headers = candidate.response?.headers ?? candidate.headers;
  const header = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    if (!headers) return undefined;
    const value = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    )?.[1];
    return value === undefined ? undefined : String(value);
  };
  const rateLimited403 =
    status === 403 &&
    (/rate limit|secondary rate|abuse detection/i.test(message) ||
      header("retry-after") !== undefined ||
      header("x-ratelimit-remaining") === "0");
  const deterministicClientStatus =
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429 &&
    !rateLimited403;
  return (
    name === "FatalError" ||
    deterministicClientStatus ||
    /Refusing to open a PR .*AGENT_ALLOWED_REPOS/i.test(message) ||
    (!rateLimited403 &&
      /\b(not found|unauthorized|forbidden|validation failed|policy (?:rejected|denied)|permission denied|invalid (?:branch|ref|target|source))\b/i.test(
        message,
      ))
  );
}

async function createPublicationAttemptStep(input: {
  runId: string;
  blockId: string;
  workspaceManifest: WorkspaceManifest;
}) {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { createOrGetPublicationAttempt } = await import("../publication/store.js");
  return createOrGetPublicationAttempt(getDb(), input);
}
createPublicationAttemptStep.maxRetries = 0;

async function verifyPullRequestHeadStep(input: {
  provider: SelectedRepository["provider"];
  repoPath: string;
  prId: number;
  headSha: string;
}): Promise<string> {
  "use step";
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  const currentHead = await createRepositoryVcsRuntime({
    provider: input.provider,
    repoPath: input.repoPath,
    baseBranch: "main",
  }).vcs.getPRHeadSha(input.prId);
  return currentHead;
}
verifyPullRequestHeadStep.maxRetries = 3;

function assertPullRequestHead(
  input: {
    provider: SelectedRepository["provider"];
    repoPath: string;
    prId: number;
    headSha: string;
  },
  currentHead: string,
): void {
  if (currentHead === input.headSha) return;
  throw new Error(
    `stale PR/MR head for ${input.provider}:${input.repoPath} #${input.prId}: ` +
      `triggered at ${input.headSha}, current head is ${currentHead}`,
  );
}

async function markPublicationPushingStep(attemptId: string): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markPublicationAttemptPushing } = await import("../publication/store.js");
  await markPublicationAttemptPushing(getDb(), attemptId);
}
markPublicationPushingStep.maxRetries = 0;

async function recordPushOutcomeStep(
  attemptId: string,
  pushResult: TrustedWorkspacePushResult,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const {
    failPublicationAttempt,
    markPublicationAttemptFinalized,
    recordPublicationRepositoryPreflight,
    recordPublicationRepositoryPush,
  } = await import("../publication/store.js");
  const db = getDb();
  for (const repository of pushResult.repositories) {
    await recordPublicationRepositoryPreflight(db, {
      attemptId,
      provider: repository.provider,
      repoPath: repository.repoPath,
      changed: repository.changed,
      expectedHead: repository.expectedHead ?? null,
      targetHead: repository.targetHead ?? null,
      failure: repository.error ?? null,
    });
    if (repository.pushed && repository.pushedHead) {
      await recordPublicationRepositoryPush(db, {
        attemptId,
        provider: repository.provider,
        repoPath: repository.repoPath,
        pushedHead: repository.pushedHead,
      });
    }
  }
  if (pushResult.pushed) {
    await markPublicationAttemptFinalized(db, attemptId);
  } else {
    await failPublicationAttempt(db, attemptId, pushResult.error ?? "workspace push failed");
  }
}
recordPushOutcomeStep.maxRetries = 3;

async function reconcilePushingPublicationStep(
  attempt: PublicationAttemptRecord,
): Promise<{
  attempt: PublicationAttemptRecord;
  unresolvedReason?: string;
  resumePush?: true;
}> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  const {
    failPublicationAttempt,
    markPublicationAttemptFinalized,
    recordPublicationRepositoryFailure,
    recordPublicationRepositoryPush,
  } = await import("../publication/store.js");
  const db = getDb();
  const repositories = attempt.repositories.map((repository) => ({ ...repository }));
  const changed = repositories.filter((repository) => repository.changed);

  if (changed.length === 0) {
    return { attempt: { ...attempt, repositories }, resumePush: true };
  }

  let knownFailure: string | null = null;
  let resumePush = false;
  for (const repository of changed) {
    if (!repository.targetHead) {
      resumePush = true;
      continue;
    }

    let currentHead: string;
    try {
      currentHead = await createRepositoryVcsRuntime({
        provider: repository.provider,
        repoPath: repository.repoPath,
        baseBranch: repository.defaultBranch,
      }).vcs.getBranchSha(repository.branchName);
    } catch (error) {
      throw new Error(
        `unable to reconcile ${repository.provider}:${repository.repoPath}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    if (currentHead === repository.targetHead) {
      if (repository.pushedHead !== repository.targetHead) {
        await recordPublicationRepositoryPush(db, {
          attemptId: attempt.id,
          provider: repository.provider,
          repoPath: repository.repoPath,
          pushedHead: repository.targetHead,
        });
        repository.pushedHead = repository.targetHead;
        repository.failure = null;
      }
      continue;
    }

    if (!repository.pushedHead && currentHead === repository.expectedHead) {
      resumePush = true;
      continue;
    }

    const reason = `${repository.provider}:${repository.repoPath}: remote head is ${currentHead}, expected published head ${repository.targetHead}`;
    repository.failure = reason;
    knownFailure ??= reason;
    await recordPublicationRepositoryFailure(db, {
      attemptId: attempt.id,
      provider: repository.provider,
      repoPath: repository.repoPath,
      failure: reason,
    });
  }

  if (knownFailure) {
    await failPublicationAttempt(db, attempt.id, knownFailure);
    return {
      attempt: {
        ...attempt,
        status: "failed",
        failure: knownFailure,
        repositories,
      },
    };
  }

  if (resumePush) {
    return { attempt: { ...attempt, repositories }, resumePush: true };
  }

  await markPublicationAttemptFinalized(db, attempt.id);
  return {
    attempt: {
      ...attempt,
      status: "finalized",
      failure: null,
      repositories,
    },
  };
}
reconcilePushingPublicationStep.maxRetries = 3;

async function loadPublicationAttemptStep(
  attemptId: string,
): Promise<PublicationAttemptRecord | null> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { getPublicationAttempt } = await import("../publication/store.js");
  return getPublicationAttempt(getDb(), attemptId);
}
loadPublicationAttemptStep.maxRetries = 3;

async function verifyFinalizedBranchHeadStep(
  repository: PublicationRepositoryRecord,
): Promise<string> {
  "use step";
  if (!repository.pushedHead) {
    throw new Error(
      `publication repository ${repository.provider}:${repository.repoPath} has no finalized head`,
    );
  }
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  const currentHead = await createRepositoryVcsRuntime({
    provider: repository.provider,
    repoPath: repository.repoPath,
    baseBranch: repository.defaultBranch,
  }).vcs.getBranchSha(repository.branchName);
  return currentHead;
}
verifyFinalizedBranchHeadStep.maxRetries = 3;

function assertFinalizedBranchHead(
  repository: PublicationRepositoryRecord,
  currentHead: string,
): void {
  if (currentHead === repository.pushedHead) return;
  throw new Error(
    `finalized branch moved for ${repository.provider}:${repository.repoPath}: ` +
      `expected ${repository.pushedHead}, current head is ${currentHead}`,
  );
}

async function markPublicationCreatingPrsStep(attemptId: string): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markPublicationAttemptCreatingPrs } = await import("../publication/store.js");
  await markPublicationAttemptCreatingPrs(getDb(), attemptId);
}
markPublicationCreatingPrsStep.maxRetries = 3;

async function recordPullRequestStep(attemptId: string, pr: WorkflowPrLink): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { recordPublicationPullRequest } = await import("../publication/store.js");
  await recordPublicationPullRequest(getDb(), {
    attemptId,
    provider: pr.provider,
    repoPath: pr.repoPath,
    pr: { id: pr.id, url: pr.url, isNew: pr.isNew },
  });
}
recordPullRequestStep.maxRetries = 3;

async function markPublicationPublishedStep(attemptId: string): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markPublicationAttemptPublished } = await import("../publication/store.js");
  await markPublicationAttemptPublished(getDb(), attemptId);
}
markPublicationPublishedStep.maxRetries = 3;

async function failPublicationStep(input: {
  attemptId: string;
  reason: string;
  repository?: { provider: SelectedRepository["provider"]; repoPath: string };
}): Promise<PublicationAttemptRecord | null> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const {
    failPublicationAttempt,
    getPublicationAttempt,
    recordPublicationRepositoryFailure,
  } = await import("../publication/store.js");
  const db = getDb();
  if (input.repository) {
    await recordPublicationRepositoryFailure(db, {
      attemptId: input.attemptId,
      ...input.repository,
      failure: input.reason,
    });
  }
  const failed = await failPublicationAttempt(db, input.attemptId, input.reason);
  return failed === false ? getPublicationAttempt(db, input.attemptId) : null;
}
failPublicationStep.maxRetries = 3;

async function recordRecoverablePublicationFailureStep(input: {
  attemptId: string;
  reason: string;
  repository: { provider: SelectedRepository["provider"]; repoPath: string };
}): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { recordPublicationRepositoryFailure } = await import("../publication/store.js");
  await recordPublicationRepositoryFailure(getDb(), {
    attemptId: input.attemptId,
    ...input.repository,
    failure: input.reason,
  });
}
recordRecoverablePublicationFailureStep.maxRetries = 3;

async function recoverableOpenPullRequestFailure(
  attempt: PublicationAttemptRecord,
  repository: PublicationRepositoryRecord,
  reason: string,
  prs: WorkflowPrLink[],
): Promise<RecoverablePublicationResult> {
  await recordRecoverablePublicationFailureStep({
    attemptId: attempt.id,
    reason,
    repository: { provider: repository.provider, repoPath: repository.repoPath },
  }).catch(() => {});
  return recoverableResult(attempt.id, reason, attempt.repositories, prs);
}

async function terminalOpenPullRequestFailure(
  attempt: PublicationAttemptRecord,
  repository: PublicationRepositoryRecord,
  reason: string,
  prs: WorkflowPrLink[],
): Promise<WorkspacePublicationResult> {
  const concurrent = await failPublicationStep({
    attemptId: attempt.id,
    reason,
    repository: { provider: repository.provider, repoPath: repository.repoPath },
  });
  return concurrent?.status === "published"
    ? publishedResult(concurrent)
    : failedResult(attempt.id, reason, attempt.repositories, prs);
}

function replayedFinalizeResult(attempt: PublicationAttemptRecord): WorkspacePublicationResult {
  if (
    attempt.status === "finalized" ||
    attempt.status === "creating_prs" ||
    attempt.status === "published"
  ) {
    return {
      status: "finalized",
      attemptId: attempt.id,
      repositories: finalizedBranches(attempt.repositories),
      prs: [],
    };
  }
  return failedResult(
    attempt.id,
    attempt.failure ?? `publication attempt is already ${attempt.status}`,
    attempt.repositories,
    prLinksFromAttempt(attempt),
  );
}

function failedResult(
  attemptId: string,
  reason: string,
  repositories: PublicationRepositoryRecord[],
  prs: WorkflowPrLink[],
): WorkspacePublicationResult {
  return {
    status: "failed",
    attemptId,
    reason,
    repositories: finalizedBranches(repositories),
    prs,
  };
}

function recoverableResult(
  attemptId: string,
  reason: string,
  repositories: PublicationRepositoryRecord[],
  prs: WorkflowPrLink[],
): RecoverablePublicationResult {
  return {
    status: "recoverable",
    attemptId,
    reason,
    repositories: finalizedBranches(repositories),
    prs,
  };
}

async function waitForPublicationRecovery(
  retryIndex: number,
  observeBudget?: () => Promise<RunBudgetObservation>,
): Promise<void> {
  const delaySeconds = Math.min(5 * 2 ** Math.min(retryIndex, 6), 300);
  if (observeBudget) {
    const before = await observeBudget();
    if (before.check.status !== "ok") throw new RunBudgetError(before.check);
    if (before.remainingDurationMs < delaySeconds * 1_000) {
      throw new RunBudgetError(
        durationBudgetFailure(before, "publication recovery backoff"),
      );
    }
  }
  const { sleep } = await import("workflow");
  await sleep(`${delaySeconds}s`);
  if (observeBudget) {
    const after = await observeBudget();
    if (after.check.status !== "ok") throw new RunBudgetError(after.check);
  }
}

function publishedResult(attempt: PublicationAttemptRecord): WorkspacePublicationResult {
  return {
    status: "published",
    attemptId: attempt.id,
    repositories: finalizedBranches(attempt.repositories),
    prs: prLinksFromAttempt(attempt),
  };
}

function finalizedBranches(repositories: PublicationRepositoryRecord[]): FinalizedBranch[] {
  return repositories.flatMap((repository) =>
    repository.changed && repository.expectedHead && repository.pushedHead
      ? [
          {
            provider: repository.provider,
            repoPath: repository.repoPath,
            branchName: repository.branchName,
            expectedHead: repository.expectedHead,
            pushedHead: repository.pushedHead,
          },
        ]
      : [],
  );
}

function finalizedBranchesFromPush(pushResult: TrustedWorkspacePushResult): FinalizedBranch[] {
  return pushResult.repositories.flatMap((repository) =>
    repository.changed && repository.pushed && repository.expectedHead && repository.pushedHead
      ? [
          {
            provider: repository.provider,
            repoPath: repository.repoPath,
            branchName: repository.branchName,
            expectedHead: repository.expectedHead,
            pushedHead: repository.pushedHead,
          },
        ]
      : [],
  );
}

function recordsFromPush(pushResult: TrustedWorkspacePushResult): PublicationRepositoryRecord[] {
  return pushResult.repositories.map((repository) => ({
    provider: repository.provider,
    repoPath: repository.repoPath,
    branchName: repository.branchName,
    defaultBranch: "",
    changed: repository.changed,
    expectedHead: repository.expectedHead ?? null,
    targetHead: repository.targetHead ?? null,
    pushedHead: repository.pushed && repository.pushedHead ? repository.pushedHead : null,
    pr: null,
    failure: repository.error ?? null,
  }));
}

function prLinksFromAttempt(attempt: PublicationAttemptRecord): WorkflowPrLink[] {
  return attempt.repositories.flatMap((repository) =>
    repository.pr ? [prLinkFromRepository(repository)] : [],
  );
}

function prLinkFromRepository(repository: PublicationRepositoryRecord): WorkflowPrLink {
  if (!repository.pr) {
    throw new Error(`publication repository ${repository.provider}:${repository.repoPath} has no PR`);
  }
  return {
    provider: repository.provider,
    repoPath: repository.repoPath,
    id: repository.pr.id,
    url: repository.pr.url,
    branch: repository.branchName,
    isNew: repository.pr.isNew,
  };
}

function sameRepository(
  left: Pick<WorkflowPrLink, "provider" | "repoPath">,
  right: Pick<WorkflowPrLink, "provider" | "repoPath">,
): boolean {
  return left.provider === right.provider && left.repoPath === right.repoPath;
}

function selectedRepositoryFromAttempt(
  repository: PublicationRepositoryRecord,
): SelectedRepository {
  return {
    provider: repository.provider,
    repoPath: repository.repoPath,
    defaultBranch: repository.defaultBranch,
    selectedRationale: "durable finalized publication",
    workflowOwnedBranch: { branchName: repository.branchName },
  };
}
