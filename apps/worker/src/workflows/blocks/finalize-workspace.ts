import { z } from "zod";
import type { ReviewLedgerDurableState } from "../../adapters/vcs/types.js";
import {
  buildReviewLedgerDurableState,
  buildReviewLedgerGuardSummaryFromDurable,
  parseReviewLedgerDurableState,
} from "../review-ledger.js";
import { settleReviewLedgerStep, type SettledThread } from "../review-ledger-settle.js";
import { isRunControlError } from "../run-control-error.js";
import { isSourcePullRequestRepository } from "../source-pull-request.js";
import type { WorkspaceGate, WorkspaceScriptDrift } from "../workspace-gate.js";
import type { FinalizedBranch } from "../workspace-publication.js";
import {
  asRepositoryScriptsOutput,
  isRepositoryScriptsRefusal,
  type RepositoryScriptsOutput,
} from "./repository-scripts-output.js";
import {
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
  type EngineCtx,
  type StepsRecord,
} from "./types.js";

export const paramsSchema = z.object({}).strict();

/**
 * The statuses a bound `checks.*` input may carry and still let publication go
 * ahead.
 *
 * "skipped" belongs here and its absence was a production outage in waiting.
 * A v1 definition binds `checks.<node>` to that node's output STATUS, and a
 * scripts block reports "skipped" for the two states that verified nothing on
 * purpose: no configuration at all, and a configuration that matched none of
 * the changed repositories. Treating those as unmet fails every run of an
 * unconfigured tenant at the publication boundary, which is the exact inverse
 * of the contract: nothing to check means the PR opens, loudly, with the
 * skip named on the block's own output.
 *
 * A run whose scripts actually ran and failed never reaches here as "skipped":
 * it reports "ok" with ok false, and the gate refuses it further down.
 */
const SATISFIED_CHECK_STATUSES: ReadonlySet<unknown> = new Set(["ok", "skipped"]);

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

/**
 * Every tracked file this run's repository scripts touched, merged per
 * repository across every script block the walk ran.
 *
 * All of them, not just the last. A group configured with restoreTree false can
 * run early and the gating selection later, and it is the early one whose files
 * are still sitting in the tree at the publication boundary; reading only the
 * last output would attribute its drift to nobody. Merged by repository and
 * deduplicated, because two selections over the same repository legitimately
 * report the same path twice.
 *
 * Recognised through the one shared guard (asRepositoryScriptsOutput), not by
 * node id: a definition names its nodes whatever it likes.
 */
export function recoverScriptDriftFromSteps(
  steps: StepsRecord,
): WorkspaceScriptDrift[] {
  const merged = new Map<string, { files: Set<string>; preExisting: Set<string> }>();
  for (const step of Object.values(steps)) {
    const output = asRepositoryScriptsOutput(step?.output);
    if (!output) continue;
    for (const entry of output.dirtied) {
      if (!entry || typeof entry.repo !== "string") continue;
      const bucket = merged.get(entry.repo) ?? {
        files: new Set<string>(),
        preExisting: new Set<string>(),
      };
      for (const file of Array.isArray(entry.files) ? entry.files : []) {
        if (typeof file === "string") bucket.files.add(file);
      }
      for (const file of Array.isArray(entry.preExisting) ? entry.preExisting : []) {
        if (typeof file === "string") bucket.preExisting.add(file);
      }

      merged.set(entry.repo, bucket);
    }
  }
  return [...merged.entries()]
    .map(([repo, bucket]) => ({
      repo,
      files: [...bucket.files],
      preExisting: [...bucket.preExisting],
    }))
    .filter((entry) => entry.files.length > 0 || entry.preExisting.length > 0);
}

/**
 * The repository-script output of the first block in this walk that reported
 * failing commands, or null when none did.
 *
 * The whole output, not a boolean: the boundary refuses with the failing
 * command, and a boolean could only pick between two sentences about the gate
 * record, which is not what the operator is looking for. Any block, not the
 * last, because a run whose first selection failed and whose second passed
 * still has a failure the operator is looking at.
 *
 * Recognised through the same shared guard as the drift recovery above.
 * Deliberately not imported from agent.ts: no production module under
 * workflows/ imports the workflow entry point, and this question is answerable
 * from the durable output alone.
 */
export function recoverScriptsFailureFromSteps(
  steps: StepsRecord,
): RepositoryScriptsOutput | null {
  for (const step of Object.values(steps)) {
    const output = asRepositoryScriptsOutput(step?.output);
    if (output && (output.anyFailed || output.outcome === "failed")) return output;
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
 * The provider writes themselves happen inside {@link settleReviewLedgerStep};
 * everything this function does (which repository was published, what to do with
 * a failure) is decision-making that belongs in workflow scope.
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
    const settled = await settleReviewLedgerStep({
      ledger,
      headSha: typeof published?.pushedHead === "string" ? published.pushedHead : null,
      prId: pr.prNumber,
      provider: pr.provider,
      repoPath: pr.repoPath,
      baseBranch: pr.baseRef,
    });
    // Stamped on ctx as well as returned: the run's failure path counts open
    // threads off this, and a note claiming a thread is unanswered when the
    // reply is already in it is worse than no note.
    ctx.reviewLedgerSettled = settled;
    return settled;
  } catch (err) {
    if (isRunControlError(err)) throw err;
    // The step contains its own per-thread failures, so only building the
    // adapter can land here. The block body runs in workflow scope, where
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
      .filter(
        ([name, status]) =>
          name.startsWith("checks.") && !SATISFIED_CHECK_STATUSES.has(status),
      )
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
      scriptDrift: recoverScriptDriftFromSteps(steps),
      scriptsFailure: recoverScriptsFailureFromSteps(steps),
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
        // The scripts' own refusal is already a finished lead, bounded so it
        // survives derivation whole. Left to the category default it would be
        // announced with the generic checks sentence (interpreter.ts
        // SAFE_EXECUTION_ERROR_MESSAGES) and the command it names would sit
        // inside the parenthesised snippet, which is where the clamp lands.
        ...(isRepositoryScriptsRefusal(publication.reason)
          ? { message: publication.reason }
          : {}),
        // Who dirtied the tree, isolated from the reason so derivation can keep
        // it whole: the composed reason is clamped head-and-tail into a
        // 160-character snippet and an appended attribution sits exactly where
        // that cut lands.
        ...(publication.cause ? { evidence: { cause: publication.cause } } : {}),
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
