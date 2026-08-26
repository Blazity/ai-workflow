import type { VcsProviderKind } from "@shared/contracts";
import type {
  ReviewLedgerDurableState,
  ReviewThreadDisposition,
  SettleReviewThreadAction,
  VCSAdapter,
} from "../adapters/vcs/types.js";
import {
  buildRunFailureNote,
  planSettlements,
  type ReviewLedgerGuardWorkItem,
  type SettleSkipReason,
} from "./review-ledger.js";
import { isRunControlError } from "./run-control-error.js";

/**
 * Runtime side of the review ledger: takes the plan that pure logic produced
 * and writes it back into the provider's threads. All decisions (what to say,
 * whether a thread may be resolved) stay in review-ledger.ts; this module only
 * does I/O and error containment.
 */

/**
 * One attempted settlement. Exactly one of `action` / `error` / `skipped` is
 * set. A type alias rather than an interface on purpose: callers put this
 * straight into a block output, and only anonymous object types are
 * structurally assignable to JsonValue.
 */
export type SettledThread = {
  threadId: string;
  alias: string;
  action?: SettleReviewThreadAction;
  error?: string;
  skipped?: SettleSkipReason;
};

export interface SettleReviewThreadsInput {
  /**
   * The durable projection, never the live ledger. Settlement has to behave the
   * same on a hot path and after a cold scheduler resume, and only this shape
   * survives the event log.
   */
  ledger: ReviewLedgerDurableState;
  /** Commit the run actually pushed, or null when it pushed nothing. */
  headSha: string | null;
  prId: number;
  /** Repository of the PR being settled, for the "nothing was pushed" error. */
  repoPath: string;
  adapter: Pick<VCSAdapter, "settleReviewThread">;
  /** Re-check that a quoted line still exists on the pushed tree. Defaults to
   * trusting the disposition; the real post-implementation check arrives with
   * the ledger wiring that fills ctx.reviewLedger. */
  evidencePresent?: (disposition: ReviewThreadDisposition) => boolean;
  /** Wall clock budget for the whole loop; the rest comes back as skipped. */
  deadlineMs?: number;
  /** Injectable clock, so the deadline is testable without real waiting. */
  now?: () => number;
}

/** Same bound as REVIEW_LEDGER_MAX_WORK_ITEMS, re-applied here because the
 * plan can only ever be as long as the feed the agent answered. */
const MAX_SETTLEMENTS = 20;

/**
 * Wall clock budget for the whole settle loop. The 300 s invocation ceiling is
 * real (an 800 s incident on prod the day this was written), and twenty
 * sequential provider round trips can approach it on a slow instance. Past the
 * budget the remaining threads are reported as skipped and left open: the next
 * run settles them, whereas a killed invocation loses the whole publication
 * result.
 */
const DEFAULT_SETTLE_DEADLINE_MS = 120_000;

/**
 * Post one reply per accepted disposition. A provider hiccup never throws:
 * settlement runs after a successful publication, so it must not turn a pushed
 * branch into a failed run. Run control signals (cancellation, budget) are the
 * one exception and propagate untouched.
 *
 * Every accepted disposition produces exactly one entry in the result, whether
 * it was answered, refused, capped or timed out. Silence about a thread is the
 * one outcome this function never produces.
 */
export async function settleReviewThreads(
  input: SettleReviewThreadsInput,
): Promise<SettledThread[]> {
  const accepted = input.ledger.dispositions;
  if (accepted.length === 0) return [];

  const plans = planSettlements({
    threads: input.ledger.feedLite,
    accepted,
    headSha: input.headSha,
    repoPath: input.repoPath,
    evidencePresent: input.evidencePresent ?? (() => true),
  });

  const now = input.now ?? Date.now;
  const deadlineMs = input.deadlineMs ?? DEFAULT_SETTLE_DEADLINE_MS;
  const startedAt = now();
  const snapshotAt = new Map(
    input.ledger.feedLite.map((entry) => [entry.threadId, entry.snapshotAt]),
  );

  const settled: SettledThread[] = [];
  let posted = 0;
  // Sequential on purpose: a fan-out of provider writes both burns the 300 s
  // invocation ceiling in one go and trips per-token rate limits, and neither
  // failure would be visible on a single thread's reply.
  for (const plan of plans) {
    const identity = { threadId: plan.threadId, alias: plan.alias };
    if (plan.kind === "error") {
      settled.push({ ...identity, error: plan.error });
      continue;
    }
    if (plan.kind === "skipped") {
      settled.push({ ...identity, skipped: plan.skipped });
      continue;
    }
    // The cap counts provider writes, the only thing it protects; a skipped or
    // failed plan costs no call and must not push a real reply over the edge.
    if (posted >= MAX_SETTLEMENTS) {
      settled.push({ ...identity, skipped: "cap" });
      continue;
    }
    if (now() - startedAt >= deadlineMs) {
      settled.push({ ...identity, skipped: "deadline" });
      continue;
    }
    posted += 1;
    try {
      const result = await input.adapter.settleReviewThread({
        prId: input.prId,
        thread: plan.post.thread,
        body: plan.post.body,
        resolve: plan.post.resolve,
        snapshotAt: snapshotAt.get(plan.threadId) ?? "",
      });
      settled.push({ ...identity, action: result.action });
    } catch (err) {
      // A cancelled or budget-exhausted run stops the loop like it stops
      // everything else; filing it as a thread failure would keep writing to
      // the provider after the run was killed. Replies are idempotent, so the
      // next run posts whatever is still missing.
      if (isRunControlError(err)) throw err;
      // One unanswerable thread is not a reason to leave the rest silent.
      settled.push({ ...identity, error: errorMessage(err) });
    }
  }
  return settled;
}

export interface SettleReviewLedgerStepInput {
  /** The durable projection; see {@link SettleReviewThreadsInput.ledger}. */
  ledger: ReviewLedgerDurableState;
  headSha: string | null;
  prId: number;
  provider: VcsProviderKind;
  repoPath: string;
  baseBranch: string;
}

/**
 * The whole settle pass as one WDK step, which is the only place these provider
 * writes may happen.
 *
 * In workflow scope the pass would be replayed in full on every resume: up to
 * twenty provider round trips redone, and the step sequence after it shifted,
 * because what runs next branches on the result (AIW-251 is exactly this shape).
 * As a step it is checkpointed once and replayed from the log.
 *
 * One step for the whole pass, not one per thread: step names have to be unique
 * and stable, and a name per thread would change with the feed. The input is
 * already the narrow projection, so what lands in the event log is bounded.
 *
 * The adapter and the evidence predicate are built inside, because neither a
 * class instance nor a function can cross a step boundary.
 */
export async function settleReviewLedgerStep(
  input: SettleReviewLedgerStepInput,
): Promise<SettledThread[]> {
  "use step";
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  // Absent threadIds mean the second verification pass never ran, so the default
  // (trust every quote) applies. A present list is that pass's verdict against
  // the tree that was pushed: anything outside it gets the degraded reply
  // instead of a quote that moved. Keyed by threadId, never by the positional
  // alias, for the same reason settlement is.
  const evidenceStillPresent = input.ledger.evidencePresentThreadIds
    ? new Set(input.ledger.evidencePresentThreadIds)
    : null;
  return settleReviewThreads({
    ledger: input.ledger,
    headSha: input.headSha,
    prId: input.prId,
    repoPath: input.repoPath,
    adapter: createRepositoryVCS({
      provider: input.provider,
      repoPath: input.repoPath,
      baseBranch: input.baseBranch,
    }),
    ...(evidenceStillPresent
      ? {
          evidencePresent: (disposition: ReviewThreadDisposition) =>
            evidenceStillPresent.has(disposition.threadId ?? ""),
        }
      : {}),
  });
}

export interface PostRunFailureNoteForRunInput {
  adapter: Pick<VCSAdapter, "postRunFailureNote">;
  prId: number;
  runId: string;
  reason: string;
  unsettledAliases: string[];
  /** Locations for those aliases, so the note names threads a reviewer can find
   * rather than run-internal labels. */
  workItems?: readonly ReviewLedgerGuardWorkItem[];
  /** The commit this run pushed before it died, when it got that far; see
   * {@link buildRunFailureNote}. */
  pushedHead?: string | null;
  /** Threads settlement already replied in; absent counts as zero. */
  answeredCount?: number;
}

/**
 * Tell the reviewer on the PR that no reply is coming. Swallows its own errors
 * because the caller is already on a failure path and must keep reporting the
 * original reason.
 */
export async function postRunFailureNoteForRun(
  input: PostRunFailureNoteForRunInput,
): Promise<{ posted: boolean; error?: string }> {
  const body = buildRunFailureNote({
    runId: input.runId,
    reason: input.reason,
    unsettledAliases: input.unsettledAliases,
    ...(input.workItems ? { workItems: input.workItems } : {}),
    ...(input.pushedHead === undefined ? {} : { pushedHead: input.pushedHead }),
    ...(input.answeredCount === undefined ? {} : { answeredCount: input.answeredCount }),
  });
  try {
    await input.adapter.postRunFailureNote({
      prId: input.prId,
      runId: input.runId,
      body,
    });
    return { posted: true };
  } catch (err) {
    return { posted: false, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).trim();
}
