import { isRunControlError } from "../run-control-error.js";
import {
  normalizeReviewResultsInput,
} from "../review-results.js";
import type { PrTriggerPayload } from "../agent-input.js";
import type { ReviewResult } from "@shared/contracts";
import type { WorkflowOwnedBranchRecord } from "../../db/queries/workflow-owned-branches.js";
import { prSubjectKey } from "../../lib/subject-key.js";
import {
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "./types.js";

export function reviewPrAtWorkflowPublishedHead(args: {
  subjectKey: string;
  pr: PrTriggerPayload;
  owned: WorkflowOwnedBranchRecord | null;
}): PrTriggerPayload {
  const { owned, pr } = args;
  // The run proves it owns this publication through its own subject. That subject
  // is the pull request, not the ticket: one ticket can own a pull request per
  // repository, so a ticket subject would have let the sibling's run retarget to
  // this pull request's published head.
  if (
    !owned?.publishedHeadSha ||
    !owned.pr ||
    args.subjectKey !==
      prSubjectKey(owned.provider, owned.repoPath, owned.pr.id) ||
    owned.provider !== pr.provider ||
    owned.repoPath !== pr.repoPath ||
    owned.pr.id !== pr.prNumber ||
    owned.branchName !== pr.headRef ||
    owned.pr.branch !== pr.headRef ||
    owned.targetBranch !== pr.baseRef
  ) {
    return pr;
  }
  return { ...pr, headSha: owned.publishedHeadSha };
}

export async function postPrReviewStep(
  args: {
    owner: { subjectKey: string; ownerToken: string; runId: string };
    pr: PrTriggerPayload;
    nodeId: string;
    attempt: number;
    activationScope: string;
    reviewResults: ReviewResult[];
  },
) {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { findWorkflowOwnedPullRequestIdentity } = await import(
    "../../db/queries/workflow-owned-branches.js"
  );
  const {
    prRunTarget,
    publishRunOwnedPrReview,
  } = await import("../pr-external-resources.js");
  const db = getDb();
  const owned = await findWorkflowOwnedPullRequestIdentity(db, {
    provider: args.pr.provider,
    repoPath: args.pr.repoPath,
    prNumber: args.pr.prNumber,
  });
  const pr = reviewPrAtWorkflowPublishedHead({
    subjectKey: args.owner.subjectKey,
    pr: args.pr,
    owned,
  });
  return publishRunOwnedPrReview({
    db,
    owner: args.owner,
    target: prRunTarget(args.owner.subjectKey, pr),
    nodeId: args.nodeId,
    attempt: args.attempt,
    activationScope: args.activationScope,
    reviewResults: args.reviewResults,
  });
}
postPrReviewStep.maxRetries = 0;

export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs = {},
  execution,
): Promise<BlockExecutionResult> => {
  if (ctx.entry.kind !== "pr_trigger") {
    return executionError("Post PR review requires a pull request trigger.", {
      category: "binding",
    });
  }
  const normalized = normalizeReviewResultsInput(resolvedInputs.reviewResults);
  if (!normalized.ok || !normalized.value) {
    return executionError(
      normalized.ok
        ? "Post PR review requires at least one Review Result."
        : normalized.message,
      { category: "binding" },
    );
  }
  try {
    const result = await postPrReviewStep({
      owner: {
        subjectKey: ctx.entry.subjectKey,
        ownerToken: ctx.entry.ownerToken,
        runId: ctx.runId,
      },
      pr: ctx.entry.pr,
      nodeId: block.id,
      attempt: execution?.attempt ?? 1,
      activationScope: execution?.activationScopeId ?? "root",
      reviewResults: normalized.value,
    });
    return { kind: "next", output: { status: "ok", ...result } };
  } catch (error) {
    if (isRunControlError(error)) throw error;
    return executionError(
      error instanceof Error ? error.message : String(error),
      { category: "provider", phase: "post-pr-review" },
    );
  }
};
