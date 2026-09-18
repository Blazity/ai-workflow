/**
 * The `vcs` capability port: what an integration implements so core can open
 * pull requests, push, read checks and settle review threads. Many providers
 * may be connected at once; core picks one per repository by its provider.
 *
 * Moved from `apps/worker/src/adapters/vcs/types.ts`, which re-exports every
 * name, so no core caller changed. That file keeps what is not the port: the
 * optional provider extensions (gate status, pull request files, reviews,
 * manual dispatch snapshots), whose gate status reference still names GitHub
 * and GitLab, and the review finding digest, which needs `node:crypto`. The
 * GitHub-only and GitLab-only fields below are debt listed in ADR-010.
 */

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

export interface PRComment {
  author: string;
  body: string;
  liked: boolean;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

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
 * through the durable event log.
 */
export type ReviewThreadTarget = {
  threadId: string; // provider id: GitLab discussion id, GitHub PRRT_ node id; for non-thread comments the comment id
  alias: string; // "T1".."Tn", assigned by code in stable order (first note createdAt asc)
  source: ReviewThreadSource; // bot = this deployment's own bot account, third_party = another provider bot account, else human
  resolvable: boolean; // provider can mark it resolved
  filePath?: string;
  line?: number;
};

export interface ReviewThread extends ReviewThreadTarget {
  awaitingHuman: boolean; // last note is a ledger reply: context only, not a work item
  notes: ReviewThreadNote[];
}

/**
 * A work item is a thread that is not awaiting a human, not opened by a third
 * party, and not the bot's own non-inline note.
 */
export interface ReviewThreadFeed {
  threads: ReviewThread[]; // unresolved threads only; work items lead the array
  truncated: number; // work items dropped beyond REVIEW_LEDGER_MAX_WORK_ITEMS
  contextTruncated: number; // context threads dropped beyond REVIEW_LEDGER_MAX_CONTEXT_THREADS, so the prompt can say the background is partial
  snapshotAt: string; // ISO 8601, when the feed was read
}

/** How many work items `listReviewThreads` keeps; the rest are counted in `truncated`. */
export const REVIEW_LEDGER_MAX_WORK_ITEMS = 20;

/**
 * Threads the ledger carries as background rather than as work: answered by the
 * bot (awaiting a human) or opened by a third-party reviewer, which the agent
 * reads but never replies to. They get their own cap so they can never crowd out
 * an unanswered human thread, and so an unbounded tail of them cannot bloat the
 * prompt.
 */
export const REVIEW_LEDGER_MAX_CONTEXT_THREADS = 20;

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
  /** Commits content through the provider API, bypassing core's memory
   * publication gate: any future caller must run its range through core's
   * published memory scope check first. */
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
