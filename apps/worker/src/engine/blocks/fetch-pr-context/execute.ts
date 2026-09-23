import {
  repositoryCatalogKey,
  type IntegrationConnectionPin,
  type RunRepositoryAccess,
  type WorkflowRepositoryScope,
} from "@shared/contracts";
import type { RunStartWorkScope } from "../../steps/run-start-settings.js";
import type { SelectedRepository } from "../../../adapters/vcs/repository-directory.js";
import type { ReviewThreadFeed } from "../../../adapters/vcs/types.js";
import type { SelectedRepositoryPromptContext } from "../../../sandbox/context.js";
import type { PrTriggerPayload } from "../../agent-input.js";
import { selectWorkItems } from "../../helpers/review-ledger.js";
import { isRunControlError } from "../../helpers/run-control-error.js";
import { catalogRefusalExecutionOptions } from "../../support/repository-access.js";
import { executionError, type BlockExecuteFn, type BlockExecutionResult, type EngineCtx } from "../support/types.js";

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

/** The eight repository workspace, restated here because `decide.ts` keeps its
 *  own copy private. Both bound the same thing: what one run may check out. */
const WORKSPACE_REPOSITORIES_MAX = 8;

/** Attach up to three PR siblings as read-only repositories, then whatever else
 * the subject's work scope already records as selected. Optional provider
 * failures degrade to the primary PR review.
 *
 * READ ONLY where the record is concerned: this step keeps the retries it has
 * always had, and a step that may run twice must not append to an append-only
 * decision trail. What a pull request run derives about its own repository is
 * written by the ticket path the next time that subject runs. */
export async function blockPrTriggerRepositoriesWithSiblingsStep(
  runId: string,
  pr: PrTriggerPayload,
  repositoryAccess: RunRepositoryAccess,
  /** The record frozen at run start and the definition's pin. An absent record,
   *  a null one, or one holding no scope all mean the same thing here: this run
   *  selects exactly what it selected before the record existed. */
  options?: {
    workScope?: RunStartWorkScope | null;
    repositoryScope?: WorkflowRepositoryScope;
    integrationPins?: readonly IntegrationConnectionPin[];
  },
): Promise<SelectedRepository[]> {
  "use step";
  const primary = await blockPrTriggerRepositoriesStep(pr.prUrl, pr);
  const recordedKeys = (options?.workScope?.scope?.entries ?? [])
    .filter((entry) => entry.state === "selected")
    .map((entry) => entry.repositoryKey);
  const { findConnectedRunPrSiblings } = await import("../../../db/repositories/runs.js");
  const { filterPinnedRepositories } = await import(
    "../../../adapters/vcs/repository-directory.js",
  );
  const { createRepositoryVCS, listVcsRepositories } = await import(
    "../../../engine/support/vcs-runtime.js"
  );
  const { logger } = await import("../../../infra/logger.js");
  const { mayRunTouchRepository } = await import(
    "../../support/repository-access.js"
  );

  const lookup = await findConnectedRunPrSiblings({
    provider: pr.provider,
    repoPath: pr.repoPath,
    prNumber: pr.prNumber,
  });
  const siblings = lookup.status === "siblings" ? lookup.siblings : [];
  // The listing is the only way to turn a recorded key back into a checkout, so
  // it is fetched when either source has something to materialise. A run with
  // neither returns here exactly as it always did, without the request.
  if (siblings.length === 0 && recordedKeys.length === 0) return primary;

  let catalog;
  try {
    catalog = (await listVcsRepositories({
      integrationPins: options?.integrationPins,
    })).repositories;
  } catch (error) {
    // Unread settings are not a provider hiccup the review can shrug off:
    // nothing is known about any provider, so the siblings would be dropped
    // without a word. The run stops, saying so (prepare-workspace maps it).
    const { isIntegrationSettingsUnreadableError } = await import(
      "../../helpers/integration-settings-unreadable.js"
    );
    if (isIntegrationSettingsUnreadableError(error)) throw error;
    logger.warn(
      { runId, error: error instanceof Error ? error.message : String(error) },
      "review_sibling_repository_listing_failed",
    );
    return primary;
  }

  const selectedSiblings: SelectedRepository[] = [];
  for (const sibling of siblings.slice(0, 3)) {
    if (!mayRunTouchRepository(repositoryAccess, sibling)) {
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
        integrationPins: options?.integrationPins,
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
  if (siblings.length > 3) {
    logger.warn(
      { runId, omitted: siblings.length - 3 },
      "review_sibling_repository_limit_reached",
    );
  }

  // What this subject's work is already recorded to touch, after the pull
  // request's own repository and its siblings have taken their places. The
  // record is read, never written: no plan is applied here and no trail row is
  // appended, so this step keeps the retries it has always had.
  const selectedFromRecord: SelectedRepository[] = [];
  const taken = new Set(
    [...primary, ...selectedSiblings].map((repository) =>
      repositoryCatalogKey({ provider: repository.provider, path: repository.repoPath }),
    ),
  );
  // The definition's pin bounds the record like it bounds every other source.
  // It is a capability, not a preference: a repository a person recorded on the
  // ticket is still outside what this definition may check out.
  const withinPin = new Set(
    filterPinnedRepositories(catalog, options?.repositoryScope).map((repository) =>
      repositoryCatalogKey({ provider: repository.provider, path: repository.repoPath }),
    ),
  );
  for (const key of recordedKeys) {
    if (taken.size >= WORKSPACE_REPOSITORIES_MAX) break;
    if (taken.has(key)) continue;
    const metadata = catalog.find(
      (repository) =>
        repositoryCatalogKey({ provider: repository.provider, path: repository.repoPath }) === key,
    );
    if (!metadata || metadata.archived || !metadata.defaultBranch) {
      logger.warn({ runId, repositoryKey: key }, "work_scope_repository_not_materialisable");
      continue;
    }
    if (!withinPin.has(key)) {
      logger.warn({ runId, repositoryKey: key }, "work_scope_repository_outside_pin");
      continue;
    }
    if (!mayRunTouchRepository(repositoryAccess, metadata)) {
      logger.warn({ runId, repositoryKey: key }, "work_scope_repository_not_allowed");
      continue;
    }
    taken.add(key);
    selectedFromRecord.push({
      provider: metadata.provider,
      repoPath: metadata.repoPath,
      defaultBranch: metadata.defaultBranch,
      selectedRationale: "recorded on this work",
    });
  }

  return [...primary, ...selectedSiblings, ...selectedFromRecord];
}

/** Repository whose PR threads the review ledger tracks: the one the run was
 * triggered on. A sibling PR's threads belong to another reviewer's
 * conversation and the run has no commit to cite there. */
export interface FetchPrContextOptions {
  reviewLedgerFor?: { provider: string; repoPath: string };
  /** The run's frozen REVIEW_LEDGER_ENABLED. Read in workflow scope by the
   *  caller and handed down, rather than parsed from the environment inside
   *  this step: the step is replayed, and a flag an operator flipped mid-flight
   *  would make one run fetch thread feeds on its first pass and not on its
   *  second. Absent reads as off, the registry default. */
  reviewLedgerEnabled?: boolean;
  integrationPins?: readonly IntegrationConnectionPin[];
}

/**
 * ONE ANSWER to "does this fetch want thread feeds", for every caller.
 *
 * A run fetches its pull request contexts more than once: the block itself, a
 * checkpoint restore, the refetch after research takes another repository, the
 * human-expansion path. A caller that leaves these options out drops
 * `reviewThreads` from the contexts while `ctx.reviewLedger` keeps the feed it
 * was built from, and the two then disagree for the rest of the run: the
 * prompt renders no alias block, so the agent has nothing to write
 * dispositions about, so verification rejects every work item, and the reviewer
 * gets a red run and a note saying their threads were rejected twice. Built
 * here so a new call site cannot forget what the first one knew.
 */
export function reviewLedgerFetchOptions(ctx: {
  entry: EngineCtx["entry"];
  settings: EngineCtx["settings"];
  integrationPins?: EngineCtx["integrationPins"];
}): FetchPrContextOptions {
  // The pins travel on every fetch, ledger or not: they decide WHICH provider
  // answers, which is not a property of the trigger that started the run.
  // Only a run somebody's review comment started gets the ledger; see the block
  // body below for why a checks-fix run on the same PR must not be given it.
  return ctx.entry.kind === "pr_trigger" && ctx.entry.triggerType === "trigger_pr_review"
    ? {
        reviewLedgerEnabled: ctx.settings.REVIEW_LEDGER_ENABLED,
        reviewLedgerFor: {
          provider: ctx.entry.pr.provider,
          repoPath: ctx.entry.pr.repoPath,
        },
        integrationPins: ctx.integrationPins,
      }
    : { integrationPins: ctx.integrationPins };
}

/**
 * Fetch PR comments, check results, and conflict status for every repository
 * with a workflow-owned PR. The only implementation: the workflow body imports
 * and calls this step (`engine/agent-workflow.ts:1555`, `:2315`, `:2577`) rather than keeping a
 * copy of its own.
 */
export async function blockFetchPrContextsStep(
  repositories: SelectedRepository[],
  repositoryAccess: RunRepositoryAccess,
  options: FetchPrContextOptions = {},
): Promise<SelectedRepositoryPromptContext[]> {
  "use step";
  const { createRepositoryVCS } = await import("../../support/vcs-runtime.js");
  const { mayRunTouchRepository, repositoryNotEnabledMessage } = await import(
    "../../support/repository-access.js"
  );

  return Promise.all(
    repositories.map(async (repo) => {
      if (!mayRunTouchRepository(repositoryAccess, repo)) {
        throw new Error(
          repositoryNotEnabledMessage("read pull request context for", repo),
        );
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
        integrationPins: options.integrationPins,
      });
      const wantsReviewThreads =
        options.reviewLedgerEnabled === true &&
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
              const { logger } = await import("../../../infra/logger.js");
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
  const { listConnectedWorkflowOwnedBranchesForTicket } = await import(
    "../../../db/repositories/runs.js"
  );
  const records = await listConnectedWorkflowOwnedBranchesForTicket(ticketKey);
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
      ctx.repositories,
      // Only a run somebody's review comment started. A checks-fix run on the
      // same PR is here to make CI green: giving it the ledger would make the
      // fix agent answer threads it was never prompted about, fail the run on
      // "no disposition survived verification", and burn one of the PR's fix
      // attempts without ever pushing the fix.
      reviewLedgerFetchOptions(ctx),
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
    const detail = err instanceof Error ? err.message : String(err);
    // A repository the catalog withholds refuses before any provider call is
    // made, so calling it a provider failure sends an operator to a forge
    // status page over a decision this deployment made itself, and clamping its
    // sentence sends the person on the ticket nowhere at all.
    return executionError(detail, catalogRefusalExecutionOptions(detail, "provider"));
  }
};
