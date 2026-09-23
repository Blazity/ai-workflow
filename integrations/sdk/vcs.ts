/**
 * The `vcs` capability port: what an integration implements so core can open
 * pull requests, push, read checks and settle review threads. Many providers
 * may be connected at once; core picks one per repository by its provider.
 *
 * Moved from `apps/worker/src/adapters/vcs/types.ts`, which re-exports every
 * name, so no core caller changed. What a provider MAY add to the port (gate
 * statuses, pull request files, published reviews, manual dispatch snapshots)
 * is in `vcs-extensions.ts`; the comment markers every provider writes are in
 * `review-markers.ts`. Only the review finding digest stays in core, because
 * it needs `node:crypto`.
 */

import type {
  GateStatusCapableVCS,
  ManualDispatchPrCapableVCS,
  PRFilesCapableVCS,
  PRReviewCapableVCS,
  RichGateStatusCapableVCS,
} from "./vcs-extensions";

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
  /** Provider-authoritative checks for this exact head. */
  checks?: PullRequestHeadChecks;
}

/** An identity minted and interpreted only by the provider that produced it. */
declare const handle: unique symbol;
export type VcsOpaqueHandle = { readonly [handle]: true };

/**
 * How a version control provider tells its own handles apart: pure functions
 * of their arguments, the same for every connection and every repository.
 *
 * Not a method of the adapter, on purpose. An adapter is per connection, and
 * core reaches one lazily: it resolves the connection on the first call and
 * forwards every call as a Promise. A synchronous answer cannot survive that
 * (the Promise it came back as read as `true`, and every failed check compared
 * equal to every other), and it never needed a connection in the first place.
 * The integration runtime carries this as `vcsHandles`, next to the adapter
 * factory, and core calls it directly.
 */
export interface VcsHandleIdentity {
  /**
   * Whether two handles this provider minted name the same thing.
   *
   * Compare by value, never by reference. A handle is stored as JSON in a
   * trigger envelope and read back parsed, and the handle it is compared with
   * is parsed from a fresh provider answer, so two handles naming the same
   * check are always different objects. `sameHandle(h, structuredClone(h))`
   * must hold.
   */
  sameHandle(left: VcsOpaqueHandle | undefined, right: VcsOpaqueHandle | undefined): boolean;
  /**
   * Only for GitHub and GitLab, which recorded failed checks before checks
   * carried a handle: the handle rebuilt from the fields the provider wrote
   * then (a check run id, a pipeline id), or `null` when those fields name
   * nothing it recognises. `check` and `pullRequest` are the stored records
   * exactly as they were written. A provider that never wrote that shape
   * leaves it out, and core treats such a check as matching nothing.
   *
   * A migration shim with a removal point: it goes once no queued or failed
   * trigger delivery of the pre-handle shape is left and no run started before
   * the handle deploy is still in flight. The query that counts those
   * deliveries is in the S11 drain note of `docs/plans/2026-09-18-integrations.md`.
   */
  recordedCheckHandle?(
    check: Readonly<Record<string, unknown>>,
    pullRequest: Readonly<Record<string, unknown>>,
  ): VcsOpaqueHandle | null;
}

export interface PullRequestFailedCheck {
  handle?: VcsOpaqueHandle;
  name: string;
  conclusion: string;
}

/**
 * What the provider says about the checks on this exact head, in terms core
 * can act on without knowing the provider's CI model.
 *
 * `failed` is every check on this head that FINISHED failed and has not been
 * superseded by a re-run, each under the handle a trigger event for it carries.
 * A provider that reports both a whole run and its parts (a pipeline and its
 * jobs) lists both, because a delivery may name either. A finished failure is
 * final for that check, so it stays here while other checks on the head are
 * still running: core binds a "checks failed" event by finding its handle in
 * this list, and a failure that waited for every other check to finish would
 * never start the run it reported.
 *
 * `state` summarises the same facts: `red` whenever `failed` is not empty,
 * otherwise `running` while any check has not finished, otherwise `green`.
 */
export interface PullRequestHeadChecks {
  state: "green" | "red" | "running";
  failed: PullRequestFailedCheck[];
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

export interface VcsRepositoryMetadata {
  provider: string;
  repoPath: string;
  name: string;
  owner: string;
  defaultBranch: string;
  description: string;
  webUrl: string;
  topics: string[];
  archived: boolean;
  private: boolean;
}

export interface VcsSandboxCredentials {
  host: string;
  authUser?: string;
  token: string;
  commitAuthor: string;
  commitEmail: string;
}

/**
 * Every member returns a Promise: core may reach an adapter before its
 * connection resolves and forwards each call once it has. Anything answerable
 * without a connection belongs to the provider instead (`VcsHandleIdentity`).
 */
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
  /**
   * The pull request as the provider reports it now.
   *
   * Throws `PullRequestUnreadableError` exactly when this connection can never
   * read it: it does not exist for this connection (404), or it is forbidden
   * to it alone (a 403 that is neither a rate limit nor a missing scope or
   * permission); `isPullRequestRefusal` decides that from the provider's
   * answer. A refused credential (401, an installation token that cannot be
   * minted, a token without the scope or the permission to read pull
   * requests) is the connection's fault and is thrown as it came, with the
   * provider's answer where the client keeps it (`providerAnswer` reads it
   * there, and core's copy of the error carries it), so the delivery stays
   * retryable. So is everything else.
   */
  getPRHead(prId: number): Promise<PullRequestHead>;
  listReviewThreads(prId: number): Promise<ReviewThreadFeed>;
  settleReviewThread(input: SettleReviewThreadInput): Promise<SettleReviewThreadResult>;
  postRunFailureNote(input: PostRunFailureNoteInput): Promise<void>;
}

/** One entry of a repository tree, as the provider reports it. */
export interface RepositorySkillTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

/**
 * Reading a repository's files at an exact commit, which is how agent skills
 * are imported from one.
 *
 * Core owns everything a skill import decides: which paths are containers,
 * what a valid `SKILL.md` is, how an artifact is hashed and what is persisted.
 * What it cannot own is the four provider calls below, so those are the port.
 *
 * `getFiles` answers `Uint8Array` rather than Node's `Buffer` because this
 * entry is bundled for a browser; every Node `Buffer` already is one.
 */
export interface RepositorySkillSource {
  getDefaultBranch(input: { owner: string; repository: string }): Promise<string>;
  resolveCommit(input: {
    owner: string;
    repository: string;
    ref: string;
  }): Promise<{ commitSha: string; treeSha: string }>;
  getTree(input: {
    owner: string;
    repository: string;
    treeSha: string;
  }): Promise<{ entries: RepositorySkillTreeEntry[]; truncated: boolean }>;
  getFiles(input: {
    owner: string;
    repository: string;
    commitSha: string;
    paths: string[];
  }): Promise<Map<string, Uint8Array>>;
}

/**
 * The adapter an integration's `vcs` factory returns: the port, plus what a
 * provider may add to it. Every addition is optional, and every one is typed
 * here, so a provider that implements one is held to the signature core calls
 * (the extensions are defined in `vcs-extensions.ts`, with the guards core
 * asks them with).
 */
export interface VcsIntegrationAdapter
  extends VCSAdapter,
    Partial<GateStatusCapableVCS>,
    Partial<RichGateStatusCapableVCS>,
    Partial<PRFilesCapableVCS>,
    Partial<PRReviewCapableVCS>,
    Partial<ManualDispatchPrCapableVCS> {
  listRepositories?(): Promise<VcsRepositoryMetadata[]>;
  loadRepositoryProfile?(repoPath: string): Promise<import("./repository-profile").RepositoryProfileBundle>;
  sandboxCredentials?(): Promise<VcsSandboxCredentials>;
  parsePullRequestUrl?(url: URL): { repoPath: string; prNumber: number } | null;
  /** Present when this provider can serve a skill import; see the port above. */
  skillSource?(): RepositorySkillSource;
}

/**
 * How core learns a version control provider's automation account: the login
 * its own comments, reviews and pushes arrive under, so none of them starts a
 * run. Two connection fields, read by core and by nothing else.
 *
 * - `VCS_BOT_LOGIN_FIELD`: every `vcs` integration declares a non-secret,
 *   optional field under this key (conformance refuses a manifest that does
 *   not), under an environment variable of its own. Core reads it from the
 *   resolved connection.
 * - `VCS_LEGACY_BOT_LOGIN_FIELD`: the single login deployments set before
 *   providers were integrations. A `vcs` integration may declare this exact
 *   key and variable (the only field allowed on a variable core reserves),
 *   and core applies it only when that provider is the deployment's sole
 *   version control provider. Core removes it from the connection it hands
 *   the adapter and the webhook, so no provider reads it.
 *
 * The values are stored under these keys on every deployment, so they never
 * change.
 */
export const VCS_BOT_LOGIN_FIELD = "botLogin";
export const VCS_LEGACY_BOT_LOGIN_FIELD = { key: "legacyBotLogin", env: "VCS_BOT_LOGIN" } as const;

const BOT_LOGIN_SUFFIX = "[bot]";

/**
 * A login as the automation account rule compares it: trimmed, lowercased, and
 * without the `[bot]` suffix GitHub appends to an App's user, so an admin who
 * typed the App's slug and a delivery that names `<slug>[bot]` agree.
 * `undefined` for a login that is empty once that is done.
 */
export function normalizeVcsLogin(login: string | null | undefined): string | undefined {
  const lowercased = login?.trim().toLowerCase();
  if (!lowercased) return undefined;
  const stripped = lowercased.endsWith(BOT_LOGIN_SUFFIX)
    ? lowercased.slice(0, -BOT_LOGIN_SUFFIX.length)
    : lowercased;
  return stripped ? stripped : undefined;
}

/** Same login, by {@link normalizeVcsLogin}. Never true when either is empty. */
export function vcsLoginsMatch(
  producer: string | null | undefined,
  configuredBot: string | null | undefined,
): boolean {
  const normalizedProducer = normalizeVcsLogin(producer);
  return normalizedProducer !== undefined && normalizedProducer === normalizeVcsLogin(configuredBot);
}

/**
 * The prefixes the post-PR gate names its own checks with: the current
 * product's, and the one checks created before the rename still carry.
 *
 * One home for both sides of the rule. Core creates checks under these names
 * (`gateCheckName` in the worker), and every VCS integration drops a failed
 * check carrying one before it becomes a trigger: acting on our own check
 * would have the gate chase its own tail, and two copies of the list had
 * already started to disagree about the bare prefix.
 */
export const GATE_CHECK_NAME_PREFIX = "AI Workflow / ";
export const LEGACY_GATE_CHECK_NAME_PREFIX = "blazebot / ";

/** A check this product's post-PR gate created, in either generation. */
export function isManagedGateCheckName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    [GATE_CHECK_NAME_PREFIX, LEGACY_GATE_CHECK_NAME_PREFIX].some(
      (prefix) => name.startsWith(prefix) && name.length > prefix.length,
    )
  );
}

/**
 * Is this review thread the agent's to answer? Three kinds are carried as
 * background instead:
 *
 * - one already answered by us, which is waiting on a person, not on the agent;
 * - one opened by a third-party reviewer, which the ledger never replies to;
 * - one of our own general notes ("automated fix pushed", a run summary), which
 *   is bookkeeping rather than review feedback. Our own *inline* thread is a
 *   real finding from the review pass and stays work.
 *
 * Here rather than in core: it is a statement about the `ReviewThread` every
 * provider produces, both core and the provider packages ask it, and the
 * workflow bundle needs it where no Node module may be imported.
 */
export function isReviewLedgerWorkItem(thread: {
  awaitingHuman: boolean;
  source: "human" | "bot" | "third_party";
  filePath?: string | undefined;
}): boolean {
  if (thread.awaitingHuman) return false;
  if (thread.source === "third_party") return false;
  return !(thread.source === "bot" && thread.filePath === undefined);
}

export function selectReviewLedgerWorkItems<
  T extends {
    awaitingHuman: boolean;
    source: "human" | "bot" | "third_party";
    filePath?: string | undefined;
  },
>(feed: { threads: T[] }): T[] {
  return feed.threads.filter((thread) => isReviewLedgerWorkItem(thread));
}
