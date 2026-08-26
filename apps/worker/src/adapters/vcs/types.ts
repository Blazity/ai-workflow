import { createHash } from "node:crypto";

export interface PullRequest {
  id: number;
  url: string;
  branch: string;
}

export interface PullRequestHead {
  headSha: string;
  /** Provider-authoritative source branch (GitHub head / GitLab source). Comment
   * events carry no branch name, so binding adopts this instead. */
  headRef?: string;
  /** Provider-authoritative target branch (GitHub base / GitLab target). */
  baseRef: string;
  /** Provider-neutral current PR/MR lifecycle state. */
  state: "open" | "closed" | "merged";
  /** GitLab's current MR head pipeline. Absent for providers without this concept. */
  headPipelineId?: number;
  /** GitLab's provider-authoritative current status for the MR head pipeline. */
  headPipelineStatus?: string;
  /** Jobs that are still failed in GitLab's current MR head pipeline. */
  headPipelineFailedChecks?: Array<{ id: number; name: string }>;
  /** GitHub's latest run for each check name on this exact head. */
  latestCheckRuns?: LatestCheckRun[];
}

export interface LatestCheckRun {
  id: number;
  name: string;
  appSlug: string;
  status: string;
  conclusion: string | null;
}

export interface ManualDispatchPullRequestSnapshot {
  prNumber: number;
  prUrl: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  title: string;
  author: string;
  isDraft: boolean;
  state: "open" | "closed" | "merged";
  mergeSha?: string;
  mergedAt?: string;
  pipelineId?: number;
  pipelineSource?: string;
  failedChecks: Array<{
    name: string;
    conclusion: string;
    detailsUrl?: string;
    checkRunId?: number;
    appSlug?: string;
  }>;
  reviews: Array<{
    state: "changes_requested" | "commented";
    author: string;
    body: string;
  }>;
}

export interface ManualDispatchPrCapableVCS {
  getManualDispatchPullRequest(prId: number): Promise<ManualDispatchPullRequestSnapshot>;
}

export function hasManualDispatchPrCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & ManualDispatchPrCapableVCS {
  return (
    typeof (adapter as Partial<ManualDispatchPrCapableVCS>)
      .getManualDispatchPullRequest === "function"
  );
}

export interface PRComment {
  author: string;
  body: string;
  liked: boolean;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

// --- Review ledger contract (types only; adapters, logic and wiring land in later stages) ---

export type ReviewThreadSource = "human" | "bot" | "third_party";

export interface ReviewThreadNote {
  author: string;
  body: string;
  createdAt: string; // ISO 8601
  isLedgerReply: boolean; // body carries a review ledger marker
}

/**
 * Identity and location of a thread, without a word of its conversation. This
 * is everything settlement needs, and the only part of a thread that may travel
 * through the durable event log; see {@link ReviewLedgerDurableState}.
 */
export type ReviewThreadTarget = {
  threadId: string; // provider id: GitLab discussion id, GitHub PRRT_ node id; for non-thread comments the comment id
  alias: string; // "T1".."Tn", assigned by code in stable order (first note createdAt asc)
  source: ReviewThreadSource; // bot = our own bot (vcs-bot-identity), third_party = provider bot account, else human
  resolvable: boolean; // provider can mark it resolved
  filePath?: string;
  line?: number;
};

export interface ReviewThread extends ReviewThreadTarget {
  awaitingHuman: boolean; // last note is a ledger reply: context only, not a work item
  notes: ReviewThreadNote[];
}

export interface ReviewThreadFeed {
  threads: ReviewThread[]; // unresolved threads only; work items are the ones isReviewLedgerWorkItem accepts, and they lead the array
  truncated: number; // work items dropped beyond the limit (REVIEW_LEDGER_MAX_WORK_ITEMS = 20)
  contextTruncated: number; // context threads dropped beyond REVIEW_LEDGER_MAX_CONTEXT_THREADS, so the prompt can say the background is partial
  snapshotAt: string; // ISO 8601, when the feed was read
}

/**
 * Is this thread the agent's to answer? Three kinds of thread are carried as
 * background instead:
 *
 * - one already answered by us, which is waiting on a person, not on the agent;
 * - one opened by a third-party reviewer, which the ledger never replies to;
 * - one of our own general notes ("automated fix pushed", a run summary), which
 *   is bookkeeping rather than review feedback. Our own *inline* thread is a
 *   real finding from the review pass and stays work.
 */
export function isReviewLedgerWorkItem(
  thread: Pick<ReviewThread, "awaitingHuman" | "source" | "filePath">,
): boolean {
  if (thread.awaitingHuman) return false;
  if (thread.source === "third_party") return false;
  return !(thread.source === "bot" && thread.filePath === undefined);
}

export const REVIEW_LEDGER_MAX_WORK_ITEMS = 20;

/**
 * Threads the ledger carries as background rather than as work: answered by the
 * bot (awaiting a human) or opened by a third-party reviewer, which the agent
 * reads but never replies to. They get their own cap so they can never crowd out
 * an unanswered human thread, and so an unbounded tail of them cannot bloat the
 * prompt.
 */
export const REVIEW_LEDGER_MAX_CONTEXT_THREADS = 20;

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

export type SettleReviewThreadAction =
  | "replied"
  | "replied_and_resolved"
  | "skipped_existing_reply"
  // Answered, not resolved, and marked stale: somebody wrote after the snapshot,
  // so the thread comes back as a work item instead of parking on a human.
  | "replied_stale";

export interface SettleReviewThreadInput {
  prId: number;
  // Identity only: settlement must work from what survives the event log.
  thread: ReviewThreadTarget;
  body: string; // already contains the ledger marker for thread.threadId
  resolve: boolean;
  snapshotAt: string;
}

export interface SettleReviewThreadResult {
  action: SettleReviewThreadAction;
}

export interface PostRunFailureNoteInput {
  prId: number;
  runId: string;
  body: string;
}

export interface CheckRunResult {
  name: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: string | null;
  logs?: string;
}

export interface VCSAdapter {
  /** Create without mutating a same-named branch owned by somebody else. */
  createBranchIfMissing(
    name: string,
    base: string,
  ): Promise<"created" | "existing">;
  /** Destructive reset; callers must prove workflow ownership before invoking. */
  resetOwnedBranch(name: string, base: string): Promise<void>;
  createPR(branch: string, title: string, body: string): Promise<PullRequest>;
  /** Commits content through the provider API, bypassing the memory publication
   * gate in trusted-workspace-publisher.ts: any future caller must run its range
   * through verifyPublishedMemoryScope first. */
  push(
    branch: string,
    files: Array<{ path: string; content: string }>,
    options?: { mergeParentSha?: string; message?: string },
  ): Promise<void>;
  getPRComments(prId: number): Promise<PRComment[]>;
  postPRComment(prId: number, body: string): Promise<{ url: string | null }>;
  getCheckRunResults(prId: number): Promise<CheckRunResult[]>;
  getPRConflictStatus(prId: number): Promise<boolean>;
  /** Re-read the provider's authoritative current PR/MR head commit. */
  getPRHeadSha(prId: number): Promise<string>;
  findPR(branch: string): Promise<PullRequest | null>;
  getBranchSha(branch: string): Promise<string>;
  /** Return null only when the provider authoritatively reports no such branch. */
  getBranchShaIfExists(branch: string): Promise<string | null>;
  getPRHead(prId: number): Promise<PullRequestHead>;
  /** Optional because only GitHub exposes Check Run identities. */
  getLatestCheckRuns?(headSha: string): Promise<LatestCheckRun[]>;
  listReviewThreads(prId: number): Promise<ReviewThreadFeed>;
  settleReviewThread(input: SettleReviewThreadInput): Promise<SettleReviewThreadResult>;
  postRunFailureNote(input: PostRunFailureNoteInput): Promise<void>;
}

export interface CheckRunAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  annotationLevel: "notice" | "warning" | "failure";
  message: string;
  title?: string;
  rawDetails?: string;
}

export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";

export interface GateStatusUpdate {
  status: "in_progress" | "completed";
  conclusion?: CheckRunConclusion;
  summary?: string;
}

export interface RichGateStatusUpdate extends GateStatusUpdate {
  details?: string;
  annotations?: CheckRunAnnotation[];
}

export type GateStatusRef =
  | { provider: "github"; id: number }
  | { provider: "gitlab"; name: string; headSha: string };

/**
 * Capability interface — *not* extended onto VCSAdapter, because GitLab
 * providers expose this differently. Callers check
 * `hasGateStatusCapability(adapter)` before
 * invoking these methods. Adding methods to VCSAdapter directly would
 * force unsupported providers to throw at runtime; this surface keeps the
 * failure to detect-time, not invoke-time.
 */
export interface GateStatusCapableVCS {
  createGateStatus(
    name: string,
    headSha: string,
    ownershipKey?: string,
  ): Promise<GateStatusRef>;
  updateGateStatus(ref: GateStatusRef, update: GateStatusUpdate): Promise<void>;
}

export function hasGateStatusCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & GateStatusCapableVCS {
  return (
    typeof (adapter as Partial<GateStatusCapableVCS>).createGateStatus ===
      "function" &&
    typeof (adapter as Partial<GateStatusCapableVCS>).updateGateStatus ===
      "function"
  );
}

export interface RichGateStatusCapableVCS {
  updateGateStatusDetails(
    ref: GateStatusRef,
    update: RichGateStatusUpdate,
  ): Promise<void>;
}

export function hasRichGateStatusCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & RichGateStatusCapableVCS {
  return (
    typeof (adapter as Partial<RichGateStatusCapableVCS>)
      .updateGateStatusDetails === "function"
  );
}

export interface PRFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: "added" | "removed" | "modified" | "renamed";
  /** Unified diff hunk. Absent for binary or very large files. */
  patch?: string;
}

export interface PRFilesCapableVCS {
  listPRFiles(prId: number): Promise<PRFile[]>;
}

export function hasPRFilesCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & PRFilesCapableVCS {
  return typeof (adapter as Partial<PRFilesCapableVCS>).listPRFiles === "function";
}

export interface PRReviewInlineComment {
  path: string;
  body: string;
  startLine: number;
  endLine: number;
  startOldLine?: number | null;
  endOldLine?: number | null;
}

/**
 * Renders one finding as a markdown list item, for the list a provider falls
 * back to when it refuses an inline position.
 *
 * Continuation lines are indented into the item deliberately. A merged review
 * comment carries its agreement note after a blank line, and an unindented
 * blank line closes a markdown list: the note would detach into its own
 * paragraph and every finding after it would start a fresh list. Indenting
 * keeps the note inside its own bullet, which is what a reader expects.
 */
export function reviewFallbackBullet(comment: PRReviewInlineComment): string {
  const range =
    comment.startLine === comment.endLine
      ? String(comment.startLine)
      : `${comment.startLine}-${comment.endLine}`;
  const [first = "", ...rest] = comment.body.split("\n");
  const continuation = rest.map((line) => (line.trim() === "" ? "" : `  ${line}`));
  return [`- \`${comment.path}:${range}\` — ${first}`, ...continuation].join("\n");
}

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
 * One formula for both providers. The MARKER FAMILIES stay provider-local, because
 * each adapter reads only what it wrote, but a digest that differed between them
 * would be a difference with no reason to exist.
 */
export function reviewFindingDigest(
  comment: Pick<PRReviewInlineComment, "path" | "body">,
): string {
  return createHash("sha256")
    .update(`${comment.path} ${comment.body}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Reads the digest a provider wrote into its finding marker, if the comment body
 * carries one. Shared because both providers currently write the same marker
 * family; a provider that diverged would keep its own reader local instead of
 * bending this one to fit two shapes.
 */
export function readReviewFindingDigest(body: string): string | null {
  return /<!-- ai-workflow-review-finding:([0-9a-f]+) -->/.exec(body)?.[1] ?? null;
}

export interface PRReviewPublication {
  idempotencyKey: string;
  /**
   * Keys earlier attempts at this same round may have marked a review with, to
   * RECOGNISE and never to write. The key was derived from the review content
   * before it became a stable round identity, so a review published back then
   * carries one of these instead, and a publication that could not see it would
   * post a duplicate beside it. Writing only the current key keeps the
   * transition one-directional.
   */
  priorIdempotencyKeys?: string[];
  /**
   * The digest of each entry in `comments`, same order and same length.
   *
   * The RECIPE lives with the caller, not here. An adapter only carries a digest:
   * it writes one into the marker on a comment it opens and reads it back verbatim
   * on a later round, so it never needs to know how the string was derived. The
   * workflow derives it from the finding's severity and prose alone, deliberately
   * excluding the agreement note, because that note embeds the number of agreeing
   * reviewers and whether the finding blocks the check: both can change while the
   * defect does not, and a digest that moved with them would strand the thread.
   */
  commentFindingDigests: string[];
  /**
   * Digests of findings this round STILL REPORTS but does not place inline: the
   * ones that lost an inline slot to the cap, and the ones whose line is no longer
   * in the diff. They are named in the summary instead.
   *
   * An adapter settles a thread when the round stops reporting its finding, and
   * `comments` alone cannot tell that apart from "reported, just not inline". Left
   * out, a finding demoted by the cap would have its thread marked resolved while
   * the summary still lists it as standing, and the two artifacts would say
   * opposite things about the same defect. Threads named here stay open and stay
   * untouched.
   */
  deferredFindingDigests?: string[];
  headSha: string;
  decision: "approve" | "request_changes";
  summary: string;
  comments: PRReviewInlineComment[];
}

export interface PRReviewPublicationResult {
  id: string;
  commentIds: Array<string | null>;
}

export interface PRReviewCapableVCS {
  publishPRReview(
    prId: number,
    publication: PRReviewPublication,
  ): Promise<PRReviewPublicationResult>;
}

export function hasPRReviewCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & PRReviewCapableVCS {
  return (
    typeof (adapter as Partial<PRReviewCapableVCS>).publishPRReview ===
    "function"
  );
}
