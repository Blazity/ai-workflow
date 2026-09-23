/**
 * What a version control integration MAY add to the `vcs` port, and what each
 * addition means: gate statuses (a check core creates and completes on a pull
 * request head), their rich form, a pull request's changed files, a published
 * review, and the snapshot a manual run starts from.
 *
 * Optional, because providers differ: GitLab has no equivalent of a check
 * run's detail payload, and a provider core has never heard of may offer none
 * of these. Each one is an optional member of `VcsIntegrationAdapter`, so a
 * provider that implements one is held to its signature by the compiler, and
 * core asks with the `has...Capability` guards below before it calls.
 *
 * ASK A RESOLVED ADAPTER. Core may hold an adapter before its connection
 * resolves; that deferred adapter forwards the port's members and nothing
 * else, so it cannot say what the provider behind it implements. Core resolves
 * the adapter first wherever it asks one of these questions.
 *
 * Moved here from `apps/worker/src/adapters/vcs/types.ts`, which re-exports
 * every name, and from the copies the GitHub and GitLab packages kept of it.
 */
import type { VCSAdapter, VcsOpaqueHandle } from "./vcs";

// ---------------------------------------------------------------------------
// Gate statuses

/** Opaque provider handle. Core stores it and hands it back without parsing. */
export type GateStatusRef = VcsOpaqueHandle;

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

export interface GateStatusCapableVCS {
  /**
   * A pending status named `name` on `headSha`. `ownershipKey` is core's id
   * for the check, so a provider that can carry it (GitHub's `external_id`)
   * lets a retry find the status it already created.
   */
  createGateStatus(name: string, headSha: string, ownershipKey?: string): Promise<GateStatusRef>;
  updateGateStatus(ref: GateStatusRef, update: GateStatusUpdate): Promise<void>;
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

export interface RichGateStatusUpdate extends GateStatusUpdate {
  details?: string;
  annotations?: CheckRunAnnotation[];
}

/** A status that also carries a detail page and line annotations. */
export interface RichGateStatusCapableVCS {
  updateGateStatusDetails(ref: GateStatusRef, update: RichGateStatusUpdate): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pull request files

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

// ---------------------------------------------------------------------------
// Published reviews

export interface PRReviewInlineComment {
  path: string;
  body: string;
  startLine: number;
  endLine: number;
  startOldLine?: number | null;
  endOldLine?: number | null;
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
  publishPRReview(prId: number, publication: PRReviewPublication): Promise<PRReviewPublicationResult>;
}

/**
 * One finding as a markdown list item, for the list a provider falls back to
 * when it refuses an inline position.
 *
 * Continuation lines are indented into the item deliberately: an unindented
 * blank line closes a markdown list, so a merged comment's agreement note would
 * detach and every finding after it would start a fresh list.
 */
export function reviewFallbackBullet(comment: PRReviewInlineComment): string {
  const range =
    comment.startLine === comment.endLine
      ? String(comment.startLine)
      : `${comment.startLine}-${comment.endLine}`;
  const [first = "", ...rest] = comment.body.split("\n");
  const continuation = rest.map((line) => (line.trim() === "" ? "" : `  ${line}`));
  return [`- \`${comment.path}:${range}\` - ${first}`, ...continuation].join("\n");
}

// ---------------------------------------------------------------------------
// Manual dispatch

/** A pull request as a manual run starts from it: the same facts a delivery
 *  would have carried, read from the provider now. */
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
  failedChecks: Array<{
    name: string;
    conclusion: string;
    detailsUrl?: string;
    handle?: VcsOpaqueHandle;
    producer: string;
    source?: string;
    /** Whether the integration trusts this producer when a workflow names
     *  none, decided by the same rule its webhook applies. */
    trustedByDefault?: boolean;
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

// ---------------------------------------------------------------------------
// The questions core asks, of a resolved adapter

export function hasGateStatusCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & GateStatusCapableVCS {
  const candidate = adapter as Partial<GateStatusCapableVCS>;
  return (
    typeof candidate.createGateStatus === "function" &&
    typeof candidate.updateGateStatus === "function"
  );
}

export function hasRichGateStatusCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & RichGateStatusCapableVCS {
  return typeof (adapter as Partial<RichGateStatusCapableVCS>).updateGateStatusDetails === "function";
}

export function hasPRFilesCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & PRFilesCapableVCS {
  return typeof (adapter as Partial<PRFilesCapableVCS>).listPRFiles === "function";
}

export function hasPRReviewCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & PRReviewCapableVCS {
  return typeof (adapter as Partial<PRReviewCapableVCS>).publishPRReview === "function";
}

export function hasManualDispatchPrCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & ManualDispatchPrCapableVCS {
  return (
    typeof (adapter as Partial<ManualDispatchPrCapableVCS>).getManualDispatchPullRequest ===
    "function"
  );
}
