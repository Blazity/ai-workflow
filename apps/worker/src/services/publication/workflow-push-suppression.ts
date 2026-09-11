import type { VcsProvider } from "../../adapters/vcs/repository-directory.js";
import type { Db } from "../../db/types.js";
import { findWorkflowOwnedPullRequestIdentity } from "../../db/repositories/runs.js";
import { findConnectedWorkflowOwnedPullRequestIdentity } from "../../db/repositories/runs.js";
import { logger } from "../../infra/logger.js";
import { vcsLoginsMatch } from "../../adapters/vcs/vcs-bot-identity.js";

export function isWorkflowGeneratedPush(input: {
  currentHeadSha?: string;
  producer?: string;
  botIdentity?: string;
  workflowPublishedHeadSha?: string;
  workflowOwnedPullRequest?: boolean;
}): boolean {
  const exactPublishedHead =
    Boolean(input.workflowPublishedHeadSha) &&
    input.currentHeadSha === input.workflowPublishedHeadSha;
  // Identity backstops the sha match instead of being disabled by a recorded sha
  // that lags the event, which is what let the workflow's own push read as
  // foreign and supersede the run that produced it.
  const botIdentityPush =
    input.workflowOwnedPullRequest === true &&
    !exactPublishedHead &&
    vcsLoginsMatch(input.producer, input.botIdentity);
  return exactPublishedHead || botIdentityPush;
}

export async function workflowPushNormalizationOptions(input: {
  db: Db;
  provider: VcsProvider;
  repoPath: string;
  prNumber: number;
}): Promise<{
  workflowPublishedHeadSha?: string;
  workflowOwnedPullRequest?: boolean;
}> {
  try {
    const owned = await findWorkflowOwnedPullRequestIdentity(input.db, input);
    if (!owned) return {};
    return {
      workflowOwnedPullRequest: true,
      ...(owned.publishedHeadSha
        ? { workflowPublishedHeadSha: owned.publishedHeadSha }
        : {}),
    };
  } catch (error) {
    // A failed ownership lookup must not turn a human webhook into a 500. The
    // exact-SHA gate is fail-open here; the next dispatch still has its normal
    // subject and delivery deduplication protections.
    logger.warn(
      {
        provider: input.provider,
        repoPath: input.repoPath,
        prNumber: input.prNumber,
        error: error instanceof Error ? error.message : String(error),
      },
      "workflow_push_suppression_lookup_failed",
    );
    return {};
  }
}

export async function connectedWorkflowPushNormalizationOptions(input: Omit<
  Parameters<typeof workflowPushNormalizationOptions>[0],
  "db"
>): Promise<{
  workflowPublishedHeadSha?: string;
  workflowOwnedPullRequest?: boolean;
}> {
  try {
    const owned = await findConnectedWorkflowOwnedPullRequestIdentity(input);
    if (!owned) return {};
    return {
      workflowOwnedPullRequest: true,
      ...(owned.publishedHeadSha
        ? { workflowPublishedHeadSha: owned.publishedHeadSha }
        : {}),
    };
  } catch (error) {
    logger.warn(
      {
        provider: input.provider,
        repoPath: input.repoPath,
        prNumber: input.prNumber,
        error: error instanceof Error ? error.message : String(error),
      },
      "workflow_push_suppression_lookup_failed",
    );
    return {};
  }
}
