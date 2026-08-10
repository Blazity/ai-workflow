import type { VcsProvider } from "../adapters/vcs/repository-directory.js";
import type { Db } from "../db/client.js";
import { findWorkflowOwnedPullRequestIdentity } from "../db/queries/workflow-owned-branches.js";
import { logger } from "./logger.js";
import { vcsLoginsMatch } from "./vcs-bot-identity.js";

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
  const legacyBotPush =
    input.workflowOwnedPullRequest === true &&
    !input.workflowPublishedHeadSha &&
    vcsLoginsMatch(input.producer, input.botIdentity);
  return exactPublishedHead || legacyBotPush;
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
