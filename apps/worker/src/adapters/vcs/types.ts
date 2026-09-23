import { createHash } from "node:crypto";
import type {
  PRReviewInlineComment,
  ReviewThreadFeed,
  ReviewThreadSource,
} from "@integrations/sdk";

// The VCS port (VCSAdapter and every type it names, plus the two review ledger
// limits an adapter applies) and what a provider may add to it (gate statuses,
// pull request files, published reviews, manual dispatch snapshots, and the
// guards core asks them with) live in @integrations/sdk (ADR-010), where an
// integration implements them. Every name core imported from here is still
// exported from here, with the same kind, so no caller changed.
//
// What stays is not the port: core's refusal for a provider that cannot read
// a pull request for a manual run, the review ledger engine types, and the
// finding digest, which needs node:crypto and so cannot live in the SDK's
// browser-safe entry.
export {
  hasGateStatusCapability,
  hasManualDispatchPrCapability,
  hasPRFilesCapability,
  hasPRReviewCapability,
  hasRichGateStatusCapability,
  REVIEW_LEDGER_MAX_CONTEXT_THREADS,
  REVIEW_LEDGER_MAX_WORK_ITEMS,
  type CheckRunAnnotation,
  type CheckRunConclusion,
  type CheckRunResult,
  type GateStatusCapableVCS,
  type GateStatusRef,
  type GateStatusUpdate,
  type ManualDispatchPrCapableVCS,
  type ManualDispatchPullRequestSnapshot,
  type PostRunFailureNoteInput,
  type PRComment,
  type PRFile,
  type PRFilesCapableVCS,
  type PRReviewCapableVCS,
  type PRReviewInlineComment,
  type PRReviewPublication,
  type PRReviewPublicationResult,
  type PullRequest,
  type PullRequestHead,
  type PullRequestHeadChecks,
  type PullRequestFailedCheck,
  type ReviewThread,
  type ReviewThreadFeed,
  type ReviewThreadNote,
  type ReviewThreadSource,
  type ReviewThreadTarget,
  type RichGateStatusCapableVCS,
  type RichGateStatusUpdate,
  type SettleReviewThreadAction,
  type SettleReviewThreadInput,
  type SettleReviewThreadResult,
  type VCSAdapter,
  type VcsIntegrationAdapter,
  type VcsOpaqueHandle,
} from "@integrations/sdk";

/** The provider has no way to read a pull request for a manual run. Its own
 *  class, so the person is told that rather than that the provider is down. */
export class ManualDispatchUnsupportedError extends Error {
  constructor(readonly provider: string) {
    super(`Version control provider ${provider} cannot read pull requests for a manual run.`);
    this.name = "ManualDispatchUnsupportedError";
  }
}

// --- Review ledger contract (types only; adapters, logic and wiring land in later stages) ---

// The work-item predicate itself is the SDK's (`isReviewLedgerWorkItem`), re-exported
// by adapters/vcs/vcs-bot-identity.ts: this module imports node:crypto for the
// finding digest, so the ledger's pure logic must not reach it through here.

export type ReviewThreadDispositionKind =
  | "actionable"
  | "already_addressed"
  | "question"
  | "out_of_scope";

// Type aliases, not interfaces: both travel inside ReviewLedgerDurableState,
// which a block writes into its JsonValue-typed output, and an interface has no
// implicit index signature to satisfy that.
export type ReviewThreadEvidence = {
  filePath: string;
  quote: string;
};

export type ReviewThreadDisposition = {
  alias: string;
  threadId?: string; // stamped by verifyDispositions from the matched work item; never supplied by the model
  disposition: ReviewThreadDispositionKind;
  reply?: string; // required by the verifier for question / out_of_scope
  evidence?: ReviewThreadEvidence; // required by the verifier for already_addressed
  evidenceUnverified?: boolean; // accepted while the branch could not be read at all; the reply never quotes such evidence
};

export interface ReviewLedgerRejection {
  alias: string;
  reason: string;
}

export interface ReviewLedgerVerification {
  accepted: ReviewThreadDisposition[];
  rejected: ReviewLedgerRejection[];
  /**
   * Dispositions the model wrote for a thread the prompt showed as context only
   * (awaiting a human, or a third party bot's). Neither accepted nor rejected:
   * answering one is a harmless mistake, and failing the run over it would be a
   * correction note the model cannot act on. Counted for the metric.
   */
  ignoredContextAliases?: string[];
  /**
   * True when no evidence could be checked at all, because every file read came
   * back empty (no clone of the PR's repository in this run's workspace). The
   * distinction matters: this is missing infrastructure, not a model that lied,
   * and the run must not report it as one.
   */
  evidenceUnavailable?: boolean;
}

export interface ReviewLedgerState {
  feed: ReviewThreadFeed;
  dispositions: ReviewThreadDisposition[];
  verification: ReviewLedgerVerification | null;
  researchDeclaresWrites?: boolean; // set by the run wiring from the research output; the publish guard unlocks zero-commit success only when this is explicitly false
  evidencePresentThreadIds?: string[]; // second verification pass output: threadIds of accepted already_addressed dispositions whose quote still exists on the tree being published; absent means the pass did not run (settle then treats all evidence as present)
}

/**
 * What settlement is allowed to remember across a cold scheduler resume.
 *
 * `ReviewLedgerState` lives on ctx, which is ephemeral heap: a resume in a cold
 * Fluid instance re-enters finalize with ctx.reviewLedger gone, and settlement
 * would silently answer nothing. The recovery path therefore reads this
 * projection back out of the agent node's checkpointed output, which means it
 * is serialized into the durable event log. Note bodies (twenty threads of
 * review prose) must never go there, for the same reason the publish guard gets
 * `ReviewLedgerGuardSummary` instead of the whole ledger. The two free-text
 * fields that do travel, a disposition's `reply` and its evidence `quote`, are
 * clipped by the builder in review-ledger.ts; neither is bounded at its source.
 */
// Spelled out rather than extending ReviewThreadTarget, and a type alias rather
// than an interface, so the projection stays assignable to a block output's
// JsonValue without a cast at every emitting node.
export type ReviewLedgerDurableFeedEntry = {
  threadId: string;
  alias: string;
  source: ReviewThreadSource;
  resolvable: boolean;
  awaitingHuman: boolean; // work item selection, which the publish guard needs
  filePath?: string;
  line?: number;
  snapshotAt: string; // carried per entry so one thread's settle needs nothing else
};

export type ReviewLedgerDurableState = {
  dispositions: ReviewThreadDisposition[]; // accepted only, each stamped with its threadId
  declaredWrites: boolean;
  truncated: number; // work items the feed dropped; the guard refuses to vouch for a partial snapshot
  rejectedCount: number; // verification rejections, for the same guard
  evidencePresentThreadIds?: string[];
  feedLite: ReviewLedgerDurableFeedEntry[];
};

/**
 * The identity of one finding's THREAD, and the reason a thread outlives the round
 * that opened it.
 *
 * Path and prose only: no line numbers and no head commit. A finding that survives
 * a push is reported again at whatever line the new diff puts it on, and a rebase
 * or force-push moves every line in the file. Keyed on position, a thread would be
 * unrecognisable after either, so a round would settle it and open an identical one
 * beside it, which is the pile this exists to stop.
 *
 * The cost runs the other way: a reviewer that REWORDS a finding produces a
 * different digest, so the earlier thread is settled and a new one opens with the
 * new wording. One live thread per finding either way, which is the property that
 * matters; a fuzzy match could not tell "the same defect, reworded" from "a
 * different defect on the same symbol".
 *
 * One formula for both providers, and one marker to carry it (`reviewFindingMarker`
 * in the SDK): a digest or a marker that differed between them would be a
 * difference with no reason to exist.
 */
export function reviewFindingDigest(
  comment: Pick<PRReviewInlineComment, "path" | "body">,
): string {
  return createHash("sha256")
    .update(`${comment.path} ${comment.body}`)
    .digest("hex")
    .slice(0, 32);
}
