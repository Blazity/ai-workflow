import { z } from "zod";
import type { WorkflowRepositoryScope } from "@shared/contracts";
import type { VcsProvider } from "../../adapters/vcs/repository-directory.js";
import type { PullRequestHead } from "../../adapters/vcs/types.js";
import type { ActiveRunOwner } from "../../lib/active-run-owner.js";
import { scrubForPublication } from "../../lib/publication-scrub.js";
import {
  AI_WORKFLOW_COMMENT_MARKER,
  hasAiWorkflowCommentMarker,
} from "../../lib/vcs-bot-identity.js";
import { isRunControlError } from "../run-control-error.js";
import {
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
  type EngineCtx,
} from "./types.js";

export const paramsSchema = z
  .object({
    body: z.string().trim().max(16000).optional(),
    target: z.enum(["primary", "all"]).default("primary"),
  })
  .strict();

interface PrCommentTarget {
  provider: VcsProvider;
  repoPath: string;
  baseBranch: string;
  prId: number;
  expectedHead: string;
  expectedState: "open" | "merged";
}

interface PostPrCommentsResult {
  comments: Array<{ provider: string; repoPath: string; prId: number; url: string | null }>;
  errors: string[];
}

async function blockPostPrCommentStep(
  targets: PrCommentTarget[],
  body: string,
  owner: ActiveRunOwner,
  repositoryScope?: WorkflowRepositoryScope,
): Promise<PostPrCommentsResult> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { assertActiveRunOwner } = await import("../../lib/active-run-owner.js");
  const { createRepositoryVCS } = await import("../../lib/vcs-runtime.js");
  const { isRepoAllowedForScope } = await import("../../lib/repo-allowlist.js");
  const db = getDb();
  const comments: PostPrCommentsResult["comments"] = [];
  const errors: string[] = [];

  // The body is {{variable}}-substituted before it gets here, so it can carry
  // {{change_summary}} or any agent block's output.
  const scrubbed = scrubForPublication(body);
  // Every comment we post carries the marker so that even a misconfigured bot
  // login cannot let our own comments re-trigger the workflow (AIW-140).
  const markedBody = hasAiWorkflowCommentMarker(scrubbed)
    ? scrubbed
    : `${scrubbed}\n\n${AI_WORKFLOW_COMMENT_MARKER}`;

  for (const target of targets) {
    try {
      if (!isRepoAllowedForScope(target, repositoryScope)) {
        throw new Error(`Refusing to comment on ${target.repoPath}: not in AGENT_ALLOWED_REPOS`);
      }
      const vcs = createRepositoryVCS({
        provider: target.provider,
        repoPath: target.repoPath,
        baseBranch: target.baseBranch,
      });
      const current = await vcs.getPRHead(target.prId);
      assertCurrentPrCommentTarget(target, current);
      await assertActiveRunOwner(db, owner);
      const { url } = await vcs.postPRComment(target.prId, markedBody);
      comments.push({
        provider: target.provider,
        repoPath: target.repoPath,
        prId: target.prId,
        url,
      });
    } catch (err) {
      if (isRunControlError(err)) throw err;
      errors.push(
        `${target.provider}:${target.repoPath}#${target.prId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { comments, errors };
}
blockPostPrCommentStep.maxRetries = 0;

function assertCurrentPrCommentTarget(
  target: PrCommentTarget,
  current: PullRequestHead,
): void {
  const identity = `${target.provider}:${target.repoPath} #${target.prId}`;
  if (current.headSha !== target.expectedHead) {
    throw new Error(
      `stale PR/MR head for ${identity}: expected ${target.expectedHead}, ` +
        `current head is ${current.headSha}`,
    );
  }
  if (current.baseRef !== target.baseBranch) {
    throw new Error(
      `stale PR/MR target for ${identity}: expected ${target.baseBranch}, ` +
        `current target is ${current.baseRef}`,
    );
  }
  if (current.state !== target.expectedState) {
    throw new Error(
      `stale PR/MR lifecycle for ${identity}: expected ${target.expectedState}, ` +
        `current state is ${current.state}`,
    );
  }
}

/**
 * post_pr_comment: comment on the run's pull requests. The PR set comes from
 * ctx.publication when the workspace was published, otherwise from the
 * pr_trigger entry payload. target "primary" comments only the first PR;
 * "all" comments every PR. Partial provider failures are execution errors;
 * successful partial results are not published as normal block output.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs = {},
): Promise<BlockExecutionResult> => {
  // A bound body wins over the authored one, but a binding that resolves to
  // nothing falls back to it instead of failing the run. The auto-fix graph
  // binds this to the fix agent's summary so the comment says what was fixed,
  // and an agent that reports no summary must still leave the pull request with
  // a comment saying a fix was pushed.
  const boundBody =
    typeof resolvedInputs.body === "string" ? resolvedInputs.body.trim() : "";
  const authoredBody =
    typeof block.params.body === "string" ? block.params.body.trim() : "";
  const body = boundBody.length > 0 ? boundBody : authoredBody;
  if (body.length === 0) {
    return executionError("post_pr_comment requires a body", {
      category: "binding",
    });
  }

  let prs: PrCommentTarget[] = [];
  if (ctx.publication && ctx.publication.prs.length > 0) {
    for (const pr of ctx.publication.prs) {
      const finalized = ctx.publication.repositories.find(
        (repository) =>
          repository.provider === pr.provider && repository.repoPath === pr.repoPath,
      );
      if (!finalized?.defaultBranch) {
        return executionError(
          `publication identity is incomplete for ${pr.provider}:${pr.repoPath}#${pr.id}: ` +
            "missing finalized head or target branch",
          { category: "binding" },
        );
      }
      prs.push({
        provider: pr.provider,
        repoPath: pr.repoPath,
        baseBranch: finalized.defaultBranch,
        prId: pr.id,
        expectedHead: finalized.pushedHead,
        expectedState: "open",
      });
    }
  } else if (ctx.entry.kind === "pr_trigger") {
    // Publication reports `prs` only when it opened one, so a graph that
    // remediates an existing pull request always lands here rather than in the
    // branch above. Its head is still this run's own work: a fix agent commits
    // AND pushes from inside the sandbox, which is what makes CI re-run. Taking
    // the sha the trigger recorded would compare the comment against a head this
    // same run superseded and refuse to post on every successful fix. Publication
    // already proved that head is ours, so prefer what it finalized, and keep the
    // trigger sha for a run that published nothing. A foreign push still fails
    // the comparison below and still stops the comment.
    const finalized = ctx.publication?.repositories.find(
      (repository) =>
        ctx.entry.kind === "pr_trigger" &&
        repository.provider === ctx.entry.pr.provider &&
        repository.repoPath === ctx.entry.pr.repoPath,
    );
    prs = [
      {
        provider: ctx.entry.pr.provider,
        repoPath: ctx.entry.pr.repoPath,
        baseBranch: ctx.entry.pr.baseRef,
        prId: ctx.entry.pr.prNumber,
        expectedHead: finalized?.pushedHead ?? ctx.entry.pr.headSha,
        expectedState: ctx.entry.triggerType === "trigger_pr_merged" ? "merged" : "open",
      },
    ];
  }
  if (prs.length === 0) {
    return executionError(
      "no pull request in scope: publish the workspace first or use a PR trigger",
      { category: "binding" },
    );
  }

  const target = block.params.target === "all" ? "all" : "primary";
  const selected = target === "all" ? prs : prs.slice(0, 1);

  try {
    const { comments, errors } = await blockPostPrCommentStep(selected, body, {
      subjectKey: ctx.entry.subjectKey,
      ownerToken: ctx.entry.ownerToken,
      runId: ctx.runId,
    }, ctx.repositoryScope);
    if (errors.length > 0) {
      return executionError(errors.join("; ").slice(0, 500), {
        category: "provider",
      });
    }
    return { kind: "next", output: { status: "ok", comments } };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "provider",
    });
  }
};
