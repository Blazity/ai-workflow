import { z } from "zod";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type { SelectedRepositoryPromptContext } from "../../sandbox/context.js";
import type { PrTriggerPayload } from "../agent-input.js";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

export const paramsSchema = z.object({}).strict();

/**
 * Resolve the repositories a PR-trigger run operates on: the PR's repository,
 * enriched with the ticket's workflow-owned branch record when one exists.
 */
export async function blockPrTriggerRepositoriesStep(
  _ticketKey: string,
  pr: PrTriggerPayload,
): Promise<SelectedRepository[]> {
  "use step";
  return [
    {
      provider: pr.provider,
      repoPath: pr.repoPath,
      defaultBranch: pr.baseRef,
      selectedRationale: `PR trigger for ${pr.provider}:${pr.repoPath} #${pr.prNumber}`,
      workflowOwnedBranch: {
        branchName: pr.headRef,
        pr: { id: pr.prNumber, url: pr.prUrl, branch: pr.headRef },
      },
    },
  ];
}

/**
 * Fetch PR comments, check results, and conflict status for every repository
 * with a workflow-owned PR. Mirrors agent.ts's fetchSelectedRepositoryPRContexts.
 */
export async function blockFetchPrContextsStep(
  repositories: SelectedRepository[],
): Promise<SelectedRepositoryPromptContext[]> {
  "use step";
  const { createRepositoryVCS } = await import("../../lib/vcs-runtime.js");
  const { isRepoAllowed } = await import("../../lib/repo-allowlist.js");

  return Promise.all(
    repositories.map(async (repo) => {
      if (!isRepoAllowed(repo.repoPath)) {
        throw new Error(`Refusing to read PR context for ${repo.repoPath}: not in AGENT_ALLOWED_REPOS`);
      }
      const pr = repo.workflowOwnedBranch?.pr;
      if (!pr) {
        return {
          repository: repo,
          prComments: [],
          checkResults: [],
          hasConflicts: false,
        };
      }
      const vcs = createRepositoryVCS({
        provider: repo.provider,
        repoPath: repo.repoPath,
        baseBranch: repo.defaultBranch,
      });
      const [prComments, checkResults, hasConflicts] = await Promise.all([
        vcs.getPRComments(pr.id),
        vcs.getCheckRunResults(pr.id),
        vcs.getPRConflictStatus(pr.id),
      ]);
      return { repository: repo, prComments, checkResults, hasConflicts };
    }),
  );
}

/**
 * fetch_pr_context: refresh per-repository PR context. Full data lands in
 * ctx.repositoryContexts for downstream agent prompts; the block output stays
 * compact (counts, check names and conclusions, conflict flags) because
 * persisted step outputs are guarded at 8KB.
 */
export const execute: BlockExecuteFn = async (_block, _steps, ctx): Promise<BlockExecutionResult> => {
  try {
    let repositories: SelectedRepository[] = ctx.selectedRepositories;
    if (repositories.length === 0 && ctx.entry.kind === "pr_trigger") {
      repositories = await blockPrTriggerRepositoriesStep(ctx.ticket.identifier, ctx.entry.pr);
    }
    if (repositories.length === 0) {
      return {
        kind: "failed",
        output: { status: "failed" },
        reason: "no repositories in scope: run prepare_workspace first or use a PR trigger",
      };
    }

    const contexts = await blockFetchPrContextsStep(repositories);
    ctx.repositoryContexts = contexts;

    return {
      kind: "next",
      output: {
        status: "ok",
        contexts: contexts.map((context) => ({
          repository: `${context.repository.provider}:${context.repository.repoPath}`,
          prCommentCount: context.prComments.length,
          checkResults: context.checkResults.map((check) => ({
            name: check.name,
            conclusion: check.conclusion,
          })),
          hasConflicts: context.hasConflicts,
        })),
      },
    };
  } catch (err) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};
