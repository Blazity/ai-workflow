import { z } from "zod";
import type { WorkflowRepositoryScope } from "@shared/contracts";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type { ReviewThreadFeed } from "../../adapters/vcs/types.js";
import type { SelectedRepositoryPromptContext } from "../../sandbox/context.js";
import type { PrTriggerPayload } from "../agent-input.js";
import { selectWorkItems } from "../review-ledger.js";
import { isRunControlError } from "../run-control-error.js";
import { executionError, type BlockExecuteFn, type BlockExecutionResult } from "./types.js";

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

/** Attach up to three PR siblings as read-only repositories. Optional provider
 * failures degrade to the primary PR review. */
export async function blockPrTriggerRepositoriesWithSiblingsStep(
  runId: string,
  pr: PrTriggerPayload,
): Promise<SelectedRepository[]> {
  "use step";
  const primary = await blockPrTriggerRepositoriesStep(pr.prUrl, pr);
  const { findRunPrSiblings } = await import("../../db/queries/run-pr-siblings.js");
  const { createRepositoryDirectoryForProviders } = await import(
    "../../adapters/vcs/repository-directory.js",
  );
  const { getConfiguredVcsProviders } = await import("../../../env.js");
  const { createRepositoryVCS } = await import("../../lib/vcs-runtime.js");
  const { getDb } = await import("../../db/client.js");
  const { logger } = await import("../../lib/logger.js");
  const { isRepoAllowed } = await import("../../lib/repo-allowlist.js");

  const lookup = await findRunPrSiblings({
    db: getDb(),
    provider: pr.provider,
    repoPath: pr.repoPath,
    prNumber: pr.prNumber,
  });
  if (lookup.status !== "siblings") return primary;

  let catalog;
  try {
    catalog = await createRepositoryDirectoryForProviders(
      getConfiguredVcsProviders(),
    ).listRepositories();
  } catch (error) {
    logger.warn(
      { runId, error: error instanceof Error ? error.message : String(error) },
      "review_sibling_repository_listing_failed",
    );
    return primary;
  }

  const selectedSiblings: SelectedRepository[] = [];
  for (const sibling of lookup.siblings.slice(0, 3)) {
    if (!isRepoAllowed(sibling.repoPath)) {
      logger.warn(
        { runId, provider: sibling.provider, repoPath: sibling.repoPath },
        "review_sibling_repository_not_allowed",
      );
      continue;
    }
    const metadata = catalog.find(
      (repository) =>
        repository.provider === sibling.provider &&
        repository.repoPath === sibling.repoPath,
    );
    if (!metadata || metadata.archived || !metadata.defaultBranch) {
      logger.warn(
        { runId, provider: sibling.provider, repoPath: sibling.repoPath },
        "review_sibling_repository_skipped",
      );
      continue;
    }
    try {
      const vcs = createRepositoryVCS({
        provider: sibling.provider,
        repoPath: sibling.repoPath,
        baseBranch: metadata.defaultBranch,
      });
      const head = await vcs.getPRHead(sibling.id);
      const openBranchSha = head.state === "open" && head.headRef
        ? await vcs.getBranchShaIfExists(head.headRef)
        : null;
      const branch = openBranchSha ? head.headRef! : metadata.defaultBranch;
      const headSha = openBranchSha ??
        await vcs.getBranchShaIfExists(metadata.defaultBranch);
      if (!headSha) {
        throw new Error(`Sibling repository ${sibling.repoPath} has no reviewable branch`);
      }
      selectedSiblings.push({
        provider: sibling.provider,
        repoPath: sibling.repoPath,
        defaultBranch: metadata.defaultBranch,
        selectedRationale: "read-only sibling PR from the same workflow run",
        reviewPullRequest: {
          id: sibling.id,
          url: sibling.url,
          branch,
          headSha,
        },
      });
    } catch (error) {
      logger.warn(
        {
          runId,
          provider: sibling.provider,
          repoPath: sibling.repoPath,
          error: error instanceof Error ? error.message : String(error),
        },
        "review_sibling_repository_unavailable",
      );
    }
  }
  if (lookup.siblings.length > 3) {
    logger.warn(
      { runId, omitted: lookup.siblings.length - 3 },
      "review_sibling_repository_limit_reached",
    );
  }
  return [...primary, ...selectedSiblings];
}

/** Repository whose PR threads the review ledger tracks: the one the run was
 * triggered on. A sibling PR's threads belong to another reviewer's
 * conversation and the run has no commit to cite there. */
export interface FetchPrContextOptions {
  reviewLedgerFor?: { provider: string; repoPath: string };
}

/**
 * Fetch PR comments, check results, and conflict status for every repository
 * with a workflow-owned PR. Mirrors agent.ts's fetchSelectedRepositoryPRContexts.
 */
export async function blockFetchPrContextsStep(
  repositories: SelectedRepository[],
  repositoryScope?: WorkflowRepositoryScope,
  options: FetchPrContextOptions = {},
): Promise<SelectedRepositoryPromptContext[]> {
  "use step";
  const { createRepositoryVCS } = await import("../../lib/vcs-runtime.js");
  const { isRepoAllowedForScope } = await import("../../lib/repo-allowlist.js");
  // Read inside the step, not in workflow scope: the flag decides one provider
  // call, and env parsing has no business running on every replay.
  const { env } = await import("../../../env.js");

  return Promise.all(
    repositories.map(async (repo) => {
      if (!isRepoAllowedForScope(repo, repositoryScope)) {
        throw new Error(`Refusing to read PR context for ${repo.repoPath}: not in AGENT_ALLOWED_REPOS`);
      }
      const pr = repo.workflowOwnedBranch?.pr ?? repo.reviewPullRequest;
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
      const wantsReviewThreads =
        env.REVIEW_LEDGER_ENABLED &&
        options.reviewLedgerFor?.provider === repo.provider &&
        options.reviewLedgerFor?.repoPath === repo.repoPath;
      const [prComments, checkResults, hasConflicts, reviewThreads] = await Promise.all([
        vcs.getPRComments(pr.id),
        vcs.getCheckRunResults(pr.id),
        vcs.getPRConflictStatus(pr.id),
        // A thread feed the provider will not hand over degrades to the
        // pre-ledger run (flat comment list, no ledger) instead of killing the
        // block: the feed is an enrichment, and a GraphQL hiccup must not turn
        // a fixable review into a failed run.
        wantsReviewThreads
          ? vcs.listReviewThreads(pr.id).catch(async (error: unknown) => {
              if (isRunControlError(error)) throw error;
              const { logger } = await import("../../lib/logger.js");
              logger.warn(
                {
                  provider: repo.provider,
                  repoPath: repo.repoPath,
                  prId: pr.id,
                  error: error instanceof Error ? error.message : String(error),
                },
                "review_ledger_feed_unavailable",
              );
              return null;
            })
          : Promise.resolve(null),
      ]);
      return {
        repository: repo,
        prComments,
        checkResults,
        hasConflicts,
        ...(reviewThreads ? { reviewThreads } : {}),
      };
    }),
  );
}

/**
 * Resolve the workflow-owned pull requests already correlated for a ticket, as
 * SelectedRepository entries ready for {@link blockFetchPrContextsStep}. Used to
 * pull PR review feedback into the run BEFORE planning on a remediation
 * re-trigger, so the plan targets the requested changes instead of re-deriving
 * the original ticket (which the PR already satisfies). Returns [] when the
 * ticket has no correlated PR yet (i.e. the first run).
 */
export async function resolveTicketWorkflowOwnedReposStep(
  ticketKey: string,
): Promise<SelectedRepository[]> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { listWorkflowOwnedBranchesForTicket } = await import(
    "../../db/queries/workflow-owned-branches.js"
  );
  const records = await listWorkflowOwnedBranchesForTicket(getDb(), ticketKey);
  return records
    .filter((record) => record.pr)
    .map((record) => ({
      provider: record.provider,
      repoPath: record.repoPath,
      // Only used to construct the VCS adapter; the PR reads key off the PR id.
      defaultBranch: record.targetBranch ?? "",
      selectedRationale: "workflow-owned PR for this ticket (review remediation)",
      workflowOwnedBranch: {
        branchName: record.branchName,
        pr: record.pr!,
      },
    }));
}

/**
 * Trace-sized view of the feed. Sources are counted over the whole feed rather
 * than over work items: third_party threads and threads awaiting a human are
 * context only, so counting them per source is the only way the trace shows
 * what the run actually saw.
 */
function summarizeReviewThreadFeed(feed: ReviewThreadFeed) {
  const bySource = { human: 0, bot: 0, third_party: 0 };
  for (const thread of feed.threads) bySource[thread.source] += 1;
  return {
    workItems: selectWorkItems(feed).length,
    awaitingHuman: feed.threads.filter((thread) => thread.awaitingHuman).length,
    bySource,
    truncated: feed.truncated,
    // Reported next to truncated because they are different losses: work the
    // next run inherits, and background this run was never shown at all.
    contextTruncated: feed.contextTruncated,
  };
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
      repositories = await blockPrTriggerRepositoriesStep(
        ctx.ticket.identifier,
        ctx.entry.pr,
      );
    }
    if (repositories.length === 0) {
      return executionError(
        "no repositories in scope: run prepare_workspace first or use a PR trigger",
        { category: "binding" },
      );
    }

    const contexts = await blockFetchPrContextsStep(
      repositories,
      ctx.repositoryScope,
      // Only a run somebody's review comment started. A checks-fix run on the
      // same PR is here to make CI green: giving it the ledger would make the
      // fix agent answer threads it was never prompted about, fail the run on
      // "no disposition survived verification", and burn one of the PR's fix
      // attempts without ever pushing the fix.
      ctx.entry.kind === "pr_trigger" && ctx.entry.triggerType === "trigger_pr_review"
        ? {
            reviewLedgerFor: {
              provider: ctx.entry.pr.provider,
              repoPath: ctx.entry.pr.repoPath,
            },
          }
        : {},
    );
    ctx.repositoryContexts = contexts;

    // Absent unless the flag is on and this is a review run, so a flag-off run
    // keeps the block's old output and leaves every downstream ledger check
    // inert. An empty feed counts as absent too: "Request changes" with a
    // summary and no inline comment produces no threads, and a ledger with
    // nothing in it would answer that review with a clean no_change and throw
    // the plan away. With no ledger the flat comment list decides, as it always
    // did.
    const rawFeed = contexts.find((context) => context.reviewThreads)?.reviewThreads;
    const feed = rawFeed && rawFeed.threads.length > 0 ? rawFeed : undefined;
    if (feed) {
      ctx.reviewLedger = { feed, dispositions: [], verification: null };
    }

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
        ...(feed ? { reviewThreads: summarizeReviewThreadFeed(feed) } : {}),
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "provider",
    });
  }
};
