import { z } from "zod";
import type {
  ReviewLedgerDurableState,
  ReviewThreadDisposition,
} from "../../adapters/vcs/types.js";
import {
  buildReviewLedgerDurableState,
  buildReviewLedgerGuardSummaryFromDurable,
  parseReviewLedgerDurableState,
} from "../review-ledger.js";
import type { SettledThread } from "../review-ledger-settle.js";
import { isRunControlError } from "../run-control-error.js";
import { isSourcePullRequestRepository } from "../source-pull-request.js";
import type { WorkspaceGate } from "../workspace-gate.js";
import type { FinalizedBranch } from "../workspace-publication.js";
import {
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
  type EngineCtx,
  type StepsRecord,
} from "./types.js";

export const paramsSchema = z.object({}).strict();

/**
 * Recover the workspace gate from a durable checks-node output. The gate is
 * ephemeral heap state on ctx.prePrGate, so a scheduler resume in a cold Fluid
 * instance (checks handler body not re-run) leaves it null while the checks
 * node's checkpointed output still carries it. Both run_pre_pr_checks and
 * run_checks emit a `gate` field; the `outcome`-string marker keeps recovery
 * pinned to a checks-shaped output. Returns null when no step carries a valid
 * gate (checks genuinely never passed), so the publication boundary still fails
 * closed with `missing_gate`.
 *
 * Iterates in reverse so the most recently completed checks output wins when a
 * run executed checks more than once (e.g. a loop): the last durable gate is the
 * one the hot path would have held on ctx.prePrGate at finalize time.
 *
 * SAFETY: this recovers a gate purely from durable checks output, so it cannot
 * observe an `invalidateWorkspaceGate` that ran AFTER checks but was never
 * re-executed on the cold-resume path. If a workspace-mutating or sandbox-restore
 * node sits BETWEEN the checks node and finalize, the hot path would have nulled
 * the gate (forcing a re-check) while a cold resume can resurrect it here. The
 * built-in linear ticket workflow has no such intervening node; custom workflows
 * can. This is bounded by the publication-boundary guards, which still re-verify
 * the immutable config version (configuration_changed) and the exact clean
 * TRACKED-file fingerprint (workspace_changed) against the live workspace. The
 * residual blind spot is untracked-only mutation, which mirrors the pre-existing
 * untracked-file tolerance the fingerprint deliberately ignores
 * (workspace-gate.ts inspectWorkspaceForGateStep, `--untracked-files=no`).
 * A follow-up that binds recovery to finalize's direct control-flow predecessor
 * (requires threading the definition edges into EngineCtx) would close it.
 */
export function recoverPrePrGateFromSteps(steps: StepsRecord): WorkspaceGate | null {
  const outputs = Object.values(steps);
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const output = outputs[index]?.output as Record<string, unknown> | undefined;
    if (!output || typeof output.outcome !== "string" || !("gate" in output)) {
      continue;
    }
    const gate = output.gate;
    if (
      gate !== null &&
      typeof gate === "object" &&
      typeof (gate as { configurationVersion?: unknown }).configurationVersion === "number" &&
      typeof (gate as { fingerprint?: unknown }).fingerprint === "string"
    ) {
      return {
        configurationVersion: (gate as WorkspaceGate).configurationVersion,
        fingerprint: (gate as WorkspaceGate).fingerprint,
      };
    }
  }
  return null;
}

/**
 * Recover the review ledger's durable projection from a checkpointed node
 * output, for exactly the reason {@link recoverPrePrGateFromSteps} exists:
 * ctx.reviewLedger is ephemeral heap, and a scheduler resume in a cold Fluid
 * instance re-enters finalize without it. Left unrecovered, settlement would
 * quietly answer nothing and the reviewer would read the silence as a dead
 * webhook.
 *
 * Iterates in reverse so the newest agent output wins when a run decided more
 * than once (a fix loop re-running the decision node).
 *
 * Three outcomes, deliberately distinct: null when no step carries a ledger at
 * all (flag off, or a plain ticket run, so behave exactly as before the ledger
 * existed), a state when the projection parses, and an error when a step does
 * carry `reviewLedger` but it is not a projection this code understands. The
 * last one is a wiring bug, and it has to be loud in the block output rather
 * than degrade into the silent no-ledger path.
 */
export function recoverReviewLedgerFromSteps(
  steps: StepsRecord,
): { state: ReviewLedgerDurableState } | { error: string } | null {
  const outputs = Object.values(steps);
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const output = outputs[index]?.output as Record<string, unknown> | undefined;
    if (!output || !("reviewLedger" in output) || output.reviewLedger == null) continue;
    const state = parseReviewLedgerDurableState(output.reviewLedger);
    return state
      ? { state }
      : {
          error:
            "review ledger recovery failed: the checkpointed reviewLedger output is not a durable ledger projection",
        };
  }
  return null;
}

/** Identity used when the failure is the ledger itself, so there is no thread
 * to name. Still a string on both fields: the block output contract requires
 * them, and an empty id reads as a bug rather than as a missing ledger. */
const UNRECOVERABLE_THREAD = { threadId: "unknown", alias: "unknown" };

type ResolvedReviewLedger =
  | { state: ReviewLedgerDurableState }
  | { error: string }
  | null;

/**
 * This run's ledger, from heap when it is there and from the durable projection
 * when a cold resume lost it. Resolved once per block execution because two
 * consumers need the same answer: the publish guard before the push, and
 * settlement after it.
 */
function resolveReviewLedger(ctx: EngineCtx, steps: StepsRecord): ResolvedReviewLedger {
  return ctx.reviewLedger
    ? { state: buildReviewLedgerDurableState(ctx.reviewLedger) }
    : recoverReviewLedgerFromSteps(steps);
}

/**
 * Answer the review threads, but only once the branch is really pushed: a reply
 * citing a commit nobody can fetch is worse than silence. Returns null when this
 * run carries no ledger (flag off, or not a PR run), which keeps the block's
 * output exactly what it was before the ledger existed.
 *
 * One pass, no retries and no new step: this runs in workflow scope after the
 * publication steps, so a second attempt would need a step name the block does
 * not own.
 */
async function settleReviewLedger(
  ctx: EngineCtx,
  recovered: ResolvedReviewLedger,
  repositories: FinalizedBranch[],
): Promise<SettledThread[] | null> {
  if (ctx.entry.kind !== "pr_trigger" || !recovered) return null;
  if ("error" in recovered) {
    ctx.reviewLedgerSettled = [{ ...UNRECOVERABLE_THREAD, error: recovered.error }];
    return ctx.reviewLedgerSettled;
  }
  const ledger = recovered.state;
  const pr = ctx.entry.pr;
  try {
    const { createRepositoryVCS } = await import("../../lib/vcs-runtime.js");
    const { settleReviewThreads } = await import("../review-ledger-settle.js");
    // Only the source PR's own repository can carry the commit a thread reply
    // cites; a sibling repository's head means nothing to that reviewer. An
    // absent entry means this repository pushed nothing, so no sha exists.
    const published = repositories.find((repository) =>
      isSourcePullRequestRepository(
        {
          provider: pr.provider,
          repoPath: pr.repoPath,
          prId: pr.prNumber,
          headSha: pr.headSha,
          baseRef: pr.baseRef,
        },
        repository,
      ),
    );
    // Absent threadIds mean the second verification pass never ran, so the
    // helper's default (trust every quote) applies. A present list is the pass
    // verdict against the tree we just pushed: anything outside it gets the
    // degraded reply instead of a quote that moved. Keyed by threadId, never by
    // the positional alias, for the same reason settlement is.
    const evidenceStillPresent = ledger.evidencePresentThreadIds
      ? new Set(ledger.evidencePresentThreadIds)
      : null;
    const settled = await settleReviewThreads({
      ledger,
      headSha: typeof published?.pushedHead === "string" ? published.pushedHead : null,
      prId: pr.prNumber,
      repoPath: pr.repoPath,
      adapter: createRepositoryVCS({
        provider: pr.provider,
        repoPath: pr.repoPath,
        baseBranch: pr.baseRef,
      }),
      ...(evidenceStillPresent
        ? {
            evidencePresent: (disposition: ReviewThreadDisposition) =>
              evidenceStillPresent.has(disposition.threadId ?? ""),
          }
        : {}),
    });
    // Stamped on ctx as well as returned: the run's failure path counts open
    // threads off this, and a note claiming a thread is unanswered when the
    // reply is already in it is worse than no note.
    ctx.reviewLedgerSettled = settled;
    return settled;
  } catch (err) {
    if (isRunControlError(err)) throw err;
    // settleReviewThreads contains its own per-thread failures, so only building
    // the adapter can land here. The block body runs in workflow scope, where
    // the logger is off limits, so the failure travels as output data rather
    // than a log line; failing the block would discard a successful push.
    const error = err instanceof Error ? err.message : String(err);
    ctx.reviewLedgerSettled = ledger.dispositions.map((disposition) => ({
      // The stamped id, or the feed's, or the alias as a last resort: an error
      // entry nobody can tie back to a thread helps no one.
      threadId:
        disposition.threadId ??
        ledger.feedLite.find((entry) => entry.alias === disposition.alias)?.threadId ??
        disposition.alias,
      alias: disposition.alias,
      error,
    }));
    return ctx.reviewLedgerSettled;
  }
}

/**
 * finalize_workspace: retain the v1 `checks.*` compatibility gate, then rely on
 * the publication boundary to independently verify the current versioned
 * pre-publication gate and exact workspace fingerprint before any push.
 * It never creates PRs; subject ownership remains held until the workflow's
 * terminal release.
 */
export const execute: BlockExecuteFn = async (
  block,
  steps,
  ctx,
  resolvedInputs = {},
): Promise<BlockExecutionResult> => {
  const unmetChecks = new Set(
    Object.entries(resolvedInputs)
      .filter(([name, status]) => name.startsWith("checks.") && status !== "ok")
      .map(([name]) => name.slice("checks.".length)),
  );
  if (unmetChecks.size > 0) {
    const unmet = [...unmetChecks];
    return executionError(`required checks not satisfied: ${unmet.join(", ")}`, {
      category: "checks",
    });
  }

  if (!ctx.sandboxId) {
    return executionError(
      "no workspace: connect prepare_workspace before finalize_workspace",
      { category: "sandbox" },
    );
  }

  if (!ctx.workspaceManifest) {
    return executionError("workspace has no manager-authored trusted manifest", {
      category: "sandbox",
    });
  }

  // Resolved before the push: the publish guard needs it, and settlement after
  // the push needs the very same answer.
  const reviewLedger = resolveReviewLedger(ctx, steps);
  const guardSummary =
    reviewLedger && "state" in reviewLedger
      ? buildReviewLedgerGuardSummaryFromDurable(reviewLedger.state)
      : null;

  try {
    const { finalizeWorkspacePublication } = await import("../workspace-publication.js");
    const publication = await finalizeWorkspacePublication({
      runId: ctx.runId,
      subjectKey: ctx.entry.subjectKey,
      ownerToken: ctx.entry.ownerToken,
      sandboxId: ctx.sandboxId,
      ticketKey: ctx.ticket.identifier,
      workspaceManifest: ctx.workspaceManifest,
      repositoryScope: ctx.repositoryScope,
      prePrGate: ctx.prePrGate ?? recoverPrePrGateFromSteps(steps),
      clarifications: ctx.clarifications,
      sourcePullRequest:
        ctx.entry.kind === "pr_trigger"
          ? {
              provider: ctx.entry.pr.provider,
              repoPath: ctx.entry.pr.repoPath,
              prId: ctx.entry.pr.prNumber,
              headSha: ctx.entry.pr.headSha,
              baseRef: ctx.entry.pr.baseRef,
            }
          : undefined,
      // Without this the publisher cannot tell a run that answered every review
      // thread without touching code from a model that skipped the work, and it
      // fails the honest one on "made no commits".
      ...(guardSummary ? { reviewLedger: guardSummary } : {}),
    });
    ctx.publication = publication;

    if (publication.status === "failed") {
      return executionError(publication.reason, {
        category: publication.failureKind === "pre_pr_gate" ? "checks" : "provider",
        phase: publication.failureKind === "pre_pr_gate" ? "pre-pr-checks" : "push",
      });
    }

    if (publication.status !== "finalized") {
      return executionError(
        `Finalize Workspace received unexpected publication status: ${publication.status}`,
        { category: "engine", phase: "push" },
      );
    }

    // Settlement is deliberately the last thing the block does: the publication
    // result is already on ctx and nothing below may change it.
    const reviewLedgerSettled = await settleReviewLedger(
      ctx,
      reviewLedger,
      publication.repositories,
    );

    return {
      kind: "next",
      output: {
        status: "finalized",
        repositories: publication.repositories.map((repository) => ({
          provider: repository.provider,
          repoPath: repository.repoPath,
          branchName: repository.branchName,
          defaultBranch: repository.defaultBranch,
          expectedHead: repository.expectedHead,
          pushedHead: repository.pushedHead,
        })),
        ...(reviewLedgerSettled ? { reviewLedgerSettled } : {}),
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "provider",
      phase: "push",
    });
  }
};
