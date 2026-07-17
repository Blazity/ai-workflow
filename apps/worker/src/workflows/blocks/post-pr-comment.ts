import { z } from "zod";
import type { VcsProvider } from "../../adapters/vcs/repository-directory.js";
import type { BlockExecuteFn, BlockExecutionResult, EngineCtx } from "./types.js";

export const paramsSchema = z
  .object({
    body: z.string().trim().min(1).max(16000),
    target: z.enum(["primary", "all"]).default("primary"),
  })
  .strict();

interface PrCommentTarget {
  provider: VcsProvider;
  repoPath: string;
  baseBranch: string;
  prId: number;
}

interface PostPrCommentsResult {
  comments: Array<{ provider: string; repoPath: string; prId: number; url: string | null }>;
  errors: string[];
}

async function blockPostPrCommentStep(
  targets: PrCommentTarget[],
  body: string,
): Promise<PostPrCommentsResult> {
  "use step";
  const { createRepositoryVCS } = await import("../../lib/vcs-runtime.js");
  const { isRepoAllowed } = await import("../../lib/repo-allowlist.js");
  const comments: PostPrCommentsResult["comments"] = [];
  const errors: string[] = [];

  for (const target of targets) {
    try {
      if (!isRepoAllowed(target.repoPath)) {
        throw new Error(`Refusing to comment on ${target.repoPath}: not in AGENT_ALLOWED_REPOS`);
      }
      const vcs = createRepositoryVCS({
        provider: target.provider,
        repoPath: target.repoPath,
        baseBranch: target.baseBranch,
      });
      const { url } = await vcs.postPRComment(target.prId, body);
      comments.push({
        provider: target.provider,
        repoPath: target.repoPath,
        prId: target.prId,
        url,
      });
    } catch (err) {
      errors.push(
        `${target.provider}:${target.repoPath}#${target.prId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { comments, errors };
}
blockPostPrCommentStep.maxRetries = 0;

function defaultBranchFor(ctx: EngineCtx, provider: VcsProvider, repoPath: string): string {
  const match = ctx.selectedRepositories.find(
    (repo) => repo.provider === provider && repo.repoPath === repoPath,
  );
  if (match) return match.defaultBranch;
  if (ctx.entry.kind === "pr_trigger") return ctx.entry.pr.baseRef;
  return "main";
}

/**
 * post_pr_comment: comment on the run's pull requests. The PR set comes from
 * ctx.publication when the workspace was published, otherwise from the
 * pr_trigger entry payload. target "primary" comments only the first PR;
 * "all" comments every PR. Partial failures return kind "failed" with the
 * comments that did land in the output.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs = {},
): Promise<BlockExecutionResult> => {
  const body =
    typeof resolvedInputs.body === "string"
      ? resolvedInputs.body.trim()
      : typeof block.params.body === "string"
        ? block.params.body.trim()
        : "";
  if (body.length === 0) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: "post_pr_comment requires a body",
    };
  }

  let prs: PrCommentTarget[] = [];
  if (ctx.publication && ctx.publication.prs.length > 0) {
    prs = ctx.publication.prs.map((pr) => ({
      provider: pr.provider,
      repoPath: pr.repoPath,
      baseBranch: defaultBranchFor(ctx, pr.provider, pr.repoPath),
      prId: pr.id,
    }));
  } else if (ctx.entry.kind === "pr_trigger") {
    prs = [
      {
        provider: ctx.entry.pr.provider,
        repoPath: ctx.entry.pr.repoPath,
        baseBranch: ctx.entry.pr.baseRef,
        prId: ctx.entry.pr.prNumber,
      },
    ];
  }
  if (prs.length === 0) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: "no pull request in scope: publish the workspace first or use a PR trigger",
    };
  }

  const target = block.params.target === "all" ? "all" : "primary";
  const selected = target === "all" ? prs : prs.slice(0, 1);

  try {
    const { comments, errors } = await blockPostPrCommentStep(selected, body);
    if (errors.length > 0) {
      return {
        kind: "failed",
        output: { status: "failed", comments },
        reason: errors.join("; ").slice(0, 500),
      };
    }
    return { kind: "next", output: { status: "ok", comments } };
  } catch (err) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};
