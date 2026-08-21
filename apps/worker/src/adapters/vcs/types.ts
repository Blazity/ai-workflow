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

export interface ReviewThread {
  threadId: string; // provider id: GitLab discussion id, GitHub PRRT_ node id; for non-thread comments the comment id
  alias: string; // "T1".."Tn", assigned by code in stable order (first note createdAt asc)
  source: ReviewThreadSource; // bot = our own bot (vcs-bot-identity), third_party = provider bot account, else human
  resolvable: boolean; // provider can mark it resolved
  awaitingHuman: boolean; // last note is a ledger reply: context only, not a work item
  filePath?: string;
  line?: number;
  notes: ReviewThreadNote[];
}

export interface ReviewThreadFeed {
  threads: ReviewThread[]; // unresolved threads only; work items = threads where awaitingHuman === false
  truncated: number; // work items dropped beyond the limit (REVIEW_LEDGER_MAX_WORK_ITEMS = 20)
  snapshotAt: string; // ISO 8601, when the feed was read
}

export const REVIEW_LEDGER_MAX_WORK_ITEMS = 20;

export type ReviewThreadDispositionKind =
  | "actionable"
  | "already_addressed"
  | "question"
  | "out_of_scope";

export interface ReviewThreadEvidence {
  filePath: string;
  quote: string;
}

export interface ReviewThreadDisposition {
  alias: string;
  threadId?: string; // stamped by verifyDispositions from the matched work item; never supplied by the model
  disposition: ReviewThreadDispositionKind;
  reply?: string; // required by the verifier for question / out_of_scope
  evidence?: ReviewThreadEvidence; // required by the verifier for already_addressed
}

export interface ReviewLedgerRejection {
  alias: string;
  reason: string;
}

export interface ReviewLedgerVerification {
  accepted: ReviewThreadDisposition[];
  rejected: ReviewLedgerRejection[];
}

export interface ReviewLedgerState {
  feed: ReviewThreadFeed;
  dispositions: ReviewThreadDisposition[];
  verification: ReviewLedgerVerification | null;
  researchDeclaresWrites?: boolean; // set by the run wiring from the research output; the publish guard unlocks zero-commit success only when this is explicitly false
  evidencePresentAliases?: string[]; // second verification pass output: aliases of accepted already_addressed dispositions whose quote still exists on the tree being published; absent means the pass did not run (settle then treats all evidence as present)
}

export type SettleReviewThreadAction =
  | "replied"
  | "replied_and_resolved"
  | "skipped_existing_reply"
  | "replied_without_resolve_human_activity";

export interface SettleReviewThreadInput {
  prId: number;
  thread: ReviewThread;
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
