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
