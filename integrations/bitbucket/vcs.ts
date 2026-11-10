import { createHash } from "node:crypto";
import {
  AI_WORKFLOW_COMMENT_MARKER,
  FatalError,
  GATE_CHECK_NAME_PREFIX,
  hasReviewLedgerFailureMarker,
  isPullRequestRefusal,
  isReopenedLedgerThread,
  isReviewLedgerNote,
  isReviewLedgerWorkItem,
  legacyReviewCommentMarker,
  markReviewLedgerReplyResolved,
  markReviewLedgerReplyStale,
  providerAnswer,
  PullRequestUnreadableError,
  readAnyReviewLedgerMarker,
  readProviderFailure,
  readReviewFindingDigest,
  readReviewLedgerMarker,
  REVIEW_LEDGER_MAX_CONTEXT_THREADS,
  REVIEW_LEDGER_MAX_WORK_ITEMS,
  reviewFallbackBullet,
  reviewFindingMarker,
  reviewHeadMarker,
  reviewLedgerFailureMarker,
  reviewSummaryMarker,
  type CheckRunAnnotation,
  type CheckRunResult,
  type GateStatusCapableVCS,
  type GateStatusRef,
  type GateStatusUpdate,
  type IntegrationHttp,
  type IntegrationLogger,
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
  type ReviewThread,
  type ReviewThreadFeed,
  type ReviewThreadSource,
  type RichGateStatusCapableVCS,
  type RichGateStatusUpdate,
  type SettleReviewThreadInput,
  type SettleReviewThreadResult,
  type VcsIntegrationAdapter,
  type VcsOpaqueHandle,
  type VcsRepositoryMetadata,
} from "@integrations/sdk";
import {
  accountLogin,
  failedStatusCheck,
  isOwnAccount,
  statusProducer,
  type BitbucketAccount,
  type BitbucketCommitStatus,
} from "./checks";
import {
  bbqlString,
  BITBUCKET_WEB,
  bitbucketClient,
  branchPath,
  repositoryPath,
  requestError,
  type BitbucketClient,
} from "./client";
import { createBitbucketProfileSource } from "./profile-source";

/**
 * Posted into a thread just before it is resolved. Resolving is Bitbucket's
 * only way to collapse a comment thread, and that word on its own would tell a
 * reader the defect was fixed. Carries the bot marker so the webhook drops the
 * comment event instead of starting another round.
 */
const SUPERSEDED_THREAD_NOTE = [
  "This thread was opened by an earlier review round and the current round no " +
    "longer reports this finding under the same wording. Resolving it here means " +
    "superseded, not verified as fixed: re-open it if the issue still stands.",
  AI_WORKFLOW_COMMENT_MARKER,
].join("\n\n");

/** The name a Code Insights report gives as its reporter. */
const REPORTER = GATE_CHECK_NAME_PREFIX.replace(/\s*\/\s*$/u, "");

/**
 * Lengths this adapter keeps text to. The API reference states none for build
 * status descriptions or Code Insights reports; these are conservative so that
 * an answer is never refused for its size (a build status description shows on
 * one line, a report's details in a side panel).
 */
const STATUS_DESCRIPTION_MAX = 255;
const REPORT_DETAILS_MAX = 2_000;
const ANNOTATION_SUMMARY_MAX = 450;
/** Code Insights: at most 100 annotations per request and 1,000 per report
 *  (API reference, "Bulk create or update annotations"). */
const ANNOTATIONS_PER_REQUEST = 100;
const ANNOTATIONS_PER_REPORT = 1_000;

/** One page of a repository listing, inside the catalog import's own budget. */
const REPOSITORIES_LIST_TIMEOUT_MS = 18_000;

const FULL_SHA = /^[0-9a-f]{40}$/u;

interface BitbucketRef {
  branch?: { name?: string };
  commit?: { hash?: string };
}

interface BitbucketPullRequest {
  id?: number;
  title?: string;
  description?: string;
  state?: string;
  draft?: boolean;
  author?: BitbucketAccount;
  source?: BitbucketRef;
  destination?: BitbucketRef;
  merge_commit?: { hash?: string } | null;
  updated_on?: string;
  links?: { html?: { href?: string } };
}

interface BitbucketComment {
  id?: number;
  content?: { raw?: string };
  user?: BitbucketAccount;
  deleted?: boolean;
  pending?: boolean;
  parent?: { id?: number };
  inline?: { path?: string; from?: number | null; to?: number | null; start_from?: number | null; start_to?: number | null };
  created_on?: string;
  resolution?: unknown;
  links?: { html?: { href?: string } };
}

interface BitbucketRepository {
  full_name?: string;
  name?: string;
  description?: string;
  is_private?: boolean;
  mainbranch?: { name?: string } | null;
  workspace?: { slug?: string };
  links?: { html?: { href?: string } };
  language?: string;
}

interface BitbucketDiffstat {
  status?: string;
  lines_added?: number;
  lines_removed?: number;
  old?: { path?: string } | null;
  new?: { path?: string } | null;
}

type BitbucketGateStatusHandle = { kind: "gate_status"; key: string; name: string; headSha: string };

function gateHandle(value: BitbucketGateStatusHandle): VcsOpaqueHandle {
  return value as unknown as VcsOpaqueHandle;
}

export interface BitbucketConfig {
  /** The context's HTTP: every request this adapter makes goes through it. */
  http: IntegrationHttp;
  token: string;
  /** `workspace/repo`, as the catalog addresses it. */
  repoPath: string;
  baseBranch: string;
  workspace: string;
  botLogin?: string;
  log?: IntegrationLogger;
}

/** A comment thread: its top-level comment and every reply under it, oldest first. */
interface CommentThread {
  root: BitbucketComment;
  notes: BitbucketComment[];
}

interface OwnedFindingThread {
  rootId: number;
  digest: string;
  resolved: boolean;
  /** Somebody other than this workflow wrote in the thread; it is never touched. */
  hasHumanReply: boolean;
  /** The superseded note is already there: a retry resolves without posting it twice. */
  hasSupersededNote: boolean;
}

export class BitbucketAdapter
  implements
    VcsIntegrationAdapter,
    GateStatusCapableVCS,
    RichGateStatusCapableVCS,
    PRFilesCapableVCS,
    PRReviewCapableVCS,
    ManualDispatchPrCapableVCS
{
  private readonly client: BitbucketClient;
  /** `undefined` until asked; `null` when `GET /user` would not say. */
  private cachedSelfUuid: string | null | undefined;

  constructor(private readonly config: BitbucketConfig) {
    this.client = bitbucketClient({ http: config.http, token: config.token });
  }

  private get repo(): string {
    return repositoryPath(this.config.repoPath);
  }

  private pr(prId: number): string {
    return `${this.repo}/pullrequests/${prId}`;
  }

  // ---------------------------------------------------------------------------
  // Repositories

  /** Every repository of the workspace the token can see, 100 a page. */
  async listRepositories(): Promise<VcsRepositoryMetadata[]> {
    const repositories = await this.client
      .all<BitbucketRepository>(`/repositories/${encodeURIComponent(this.config.workspace)}?pagelen=100`, {
        init: { timeoutMs: REPOSITORIES_LIST_TIMEOUT_MS },
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new Error(`Bitbucket repositories list timed out after ${REPOSITORIES_LIST_TIMEOUT_MS}ms`, {
            cause: error,
          });
        }
        throw error;
      });
    return repositories.filter((repository) => typeof repository.full_name === "string").map(mapRepository);
  }

  loadRepositoryProfile(repoPath: string) {
    return createBitbucketProfileSource(this.client, repoPath).loadProfile();
  }

  async sandboxCredentials() {
    return {
      host: BITBUCKET_WEB,
      // Bitbucket's documented git user for every access token kind.
      authUser: "x-token-auth",
      token: this.config.token,
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "ai-workflow@blazity.com",
    };
  }

  // ---------------------------------------------------------------------------
  // Branches and commits

  async createBranchIfMissing(name: string, base: string): Promise<"created" | "existing"> {
    const target = await this.baseCommit(base);
    try {
      await this.createBranch(name, target);
      return "created";
    } catch (error) {
      // Bitbucket refuses a branch that already exists. Asking again is what
      // tells that apart from any other refusal, whatever its wording.
      const status = statusOf(error);
      if ((status === 400 || status === 409) && (await this.getBranchShaIfExists(name)) !== null) {
        return "existing";
      }
      throw error;
    }
  }

  async resetOwnedBranch(name: string, base: string): Promise<void> {
    // Not atomic: Bitbucket has no force-update for a branch, so a reset is a
    // delete followed by a create, as on GitLab. A failure between the two
    // leaves the branch deleted; the workflow-owned-branch ledger row still
    // names it, so the next attempt runs this again and the create restores it.
    const target = await this.baseCommit(base);
    const path = `${this.repo}/refs/branches/${branchPath(name)}`;
    const response = await this.client.send(path, { method: "DELETE" });
    // Already gone: an earlier attempt's delete landed and answered badly.
    if (!response.ok && response.status !== 404) throw await requestError(response, "DELETE", path);
    await this.createBranch(name, target);
  }

  private async createBranch(name: string, hash: string): Promise<void> {
    await this.client.json(`${this.repo}/refs/branches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, target: { hash } }),
    });
  }

  /**
   * The commit a new branch starts from. An empty repository has no branch at
   * all, and the first commit through the source API defines its main branch,
   * so one is seeded there; a repository that has branches but not this one is
   * a configuration error and is said so.
   */
  private async baseCommit(base: string): Promise<string> {
    const existing = await this.getBranchShaIfExists(base);
    if (existing !== null) return existing;
    const branches = await this.client.json<{ values?: unknown[] }>(`${this.repo}/refs/branches?pagelen=1`);
    if ((branches.values ?? []).length > 0) {
      throw new FatalError(`Bitbucket repository ${this.config.repoPath} has no branch ${base}.`);
    }
    const form = new URLSearchParams({ message: "Initial commit", branch: base, "/README.md": "# Repository\n" });
    try {
      await this.client.json(`${this.repo}/src`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch (error) {
      throw new Error(
        `Failed to seed empty repository ${this.config.repoPath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return this.getBranchSha(base);
  }

  async push(
    branch: string,
    files: Array<{ path: string; content: string }>,
    options?: { mergeParentSha?: string; message?: string },
  ): Promise<void> {
    // The source API creates single-parent commits: its reference marks more
    // than one parent as deprecated and accepts only one. A merge commit would
    // silently lose its second parent, so it is refused loudly instead.
    if (options?.mergeParentSha) {
      throw new FatalError(
        "Bitbucket adapter does not support merge-commit push (mergeParentSha): the source API accepts only one parent.",
      );
    }
    if (files.length === 0) return;
    const form = new URLSearchParams();
    form.set("message", options?.message ?? "feat: agent implementation");
    form.set("branch", branch);
    // A leading slash keeps a file called `message` or `branch` from being
    // read as the commit's metadata (API reference, "Create a commit by
    // uploading a file"). Adding a file that exists overwrites it.
    for (const file of files) form.append(`/${file.path.replace(/^\/+/u, "")}`, file.content);
    await this.client.json(`${this.repo}/src`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  }

  async getBranchSha(branch: string): Promise<string> {
    try {
      const data = await this.client.json<{ target?: { hash?: string } }>(
        `${this.repo}/refs/branches/${branchPath(branch)}`,
      );
      const hash = data.target?.hash;
      if (!hash) throw new Error(`Bitbucket branch ${branch} has no target commit`);
      return hash;
    } catch (error) {
      throwWithProviderRetrySemantics(error);
    }
  }

  async getBranchShaIfExists(branch: string): Promise<string | null> {
    const path = `${this.repo}/refs/branches/${branchPath(branch)}`;
    const response = await this.client.send(path);
    if (response.status === 404) return null;
    if (!response.ok) throwWithProviderRetrySemantics(await requestError(response, "GET", path));
    const data = (await response.json()) as { target?: { hash?: string } };
    return data.target?.hash ?? null;
  }

  /** A commit's full hash. Bitbucket abbreviates the hashes it puts on a pull
   *  request (`d3022fc0ca3d`); core compares heads by the full one. */
  private async fullHash(hash: string): Promise<string> {
    if (FULL_SHA.test(hash)) return hash;
    const commit = await this.client.json<{ hash?: string }>(
      `${this.repo}/commit/${encodeURIComponent(hash)}`,
    );
    if (!commit.hash || !FULL_SHA.test(commit.hash)) {
      throw new Error(`Bitbucket did not return a full hash for commit ${hash}`);
    }
    return commit.hash;
  }

  // ---------------------------------------------------------------------------
  // Pull requests

  async createPR(branch: string, title: string, body: string): Promise<PullRequest> {
    try {
      const pr = await this.client.json<BitbucketPullRequest>(`${this.repo}/pullrequests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: body,
          source: { branch: { name: branch } },
          destination: { branch: { name: this.config.baseBranch } },
        }),
      });
      return { id: Number(pr.id), url: this.pullRequestUrl(pr), branch };
    } catch (error) {
      throwWithProviderRetrySemantics(error);
    }
  }

  async findPR(branch: string): Promise<PullRequest | null> {
    const q = [
      `source.branch.name=${bbqlString(branch)}`,
      `destination.branch.name=${bbqlString(this.config.baseBranch)}`,
      `state="OPEN"`,
    ].join(" AND ");
    try {
      const page = await this.client.json<{ values?: BitbucketPullRequest[] }>(
        `${this.repo}/pullrequests?pagelen=1&q=${encodeURIComponent(q)}`,
      );
      const pr = page.values?.[0];
      if (!pr || typeof pr.id !== "number") return null;
      return { id: pr.id, url: this.pullRequestUrl(pr), branch: pr.source?.branch?.name ?? branch };
    } catch (error) {
      throwWithProviderRetrySemantics(error);
    }
  }

  private pullRequestUrl(pr: BitbucketPullRequest): string {
    return pr.links?.html?.href ?? `${BITBUCKET_WEB}/${this.config.repoPath}/pull-requests/${pr.id}`;
  }

  async getPRHead(prId: number): Promise<PullRequestHead> {
    return (await this.readPullRequestHead(prId)).head;
  }

  /** One read of the pull request and its head's build statuses, for the head
   *  core binds a delivery against and for the manual dispatch snapshot. */
  private async readPullRequestHead(prId: number): Promise<{
    pr: BitbucketPullRequest;
    head: PullRequestHead;
    statuses: BitbucketCommitStatus[];
  }> {
    let pr: BitbucketPullRequest;
    try {
      pr = await this.client.json<BitbucketPullRequest>(this.pr(prId));
    } catch (error) {
      // One this token may never read (404, or a 403 that is not about the
      // token's scopes) is closed for good; a refused token is the
      // connection's fault and is thrown as it came.
      if (isPullRequestRefusal(error)) {
        throw new PullRequestUnreadableError(
          `Bitbucket pull request #${prId} in ${this.config.repoPath} cannot be read with this token`,
          { cause: error },
        );
      }
      throw error;
    }
    const shortHead = pr.source?.commit?.hash;
    if (!shortHead) throw new Error(`Bitbucket PR #${prId} is missing its head commit`);
    const headSha = await this.fullHash(shortHead);
    const baseRef = pr.destination?.branch?.name?.trim();
    if (!baseRef) throw new Error(`Bitbucket PR #${prId} is missing its destination branch`);
    const state =
      pr.state === "OPEN"
        ? ("open" as const)
        : pr.state === "MERGED"
          ? ("merged" as const)
          : pr.state === "DECLINED" || pr.state === "SUPERSEDED"
            ? ("closed" as const)
            : null;
    if (!state) throw new Error(`Bitbucket PR #${prId} has unsupported state ${String(pr.state)}`);
    const statuses = await this.commitStatuses(headSha);
    const failed = statuses.flatMap((status) => {
      const check = failedStatusCheck(status, headSha);
      return check ? [{ handle: check.handle, name: check.name, conclusion: check.conclusion }] : [];
    });
    return {
      pr,
      statuses,
      head: {
        headSha,
        ...(pr.source?.branch?.name ? { headRef: pr.source.branch.name } : {}),
        baseRef,
        state,
        checks: {
          state:
            failed.length > 0
              ? "red"
              : statuses.some((status) => status.state === "INPROGRESS")
                ? "running"
                : "green",
          failed,
        },
      },
    };
  }

  private commitStatuses(sha: string): Promise<BitbucketCommitStatus[]> {
    return this.client.all<BitbucketCommitStatus>(`${this.repo}/commit/${sha}/statuses?pagelen=100`);
  }

  async getManualDispatchPullRequest(prId: number): Promise<ManualDispatchPullRequestSnapshot> {
    const { pr, head, statuses } = await this.readPullRequestHead(prId);
    const comments = await this.getPRComments(prId);
    const mergeHash = pr.merge_commit?.hash;
    const mergeSha = head.state === "merged" && mergeHash ? await this.fullHash(mergeHash) : undefined;
    return {
      prNumber: prId,
      prUrl: this.pullRequestUrl(pr),
      headRef: pr.source?.branch?.name ?? "",
      headSha: head.headSha,
      baseRef: head.baseRef,
      title: pr.title ?? "",
      author: accountLogin(pr.author, this.config.botLogin),
      isDraft: pr.draft === true,
      state: head.state,
      ...(mergeSha ? { mergeSha } : {}),
      ...(head.state === "merged" && pr.updated_on ? { mergedAt: pr.updated_on } : {}),
      // What the webhook reports for these statuses, under the same producer
      // and trust, so a manual run of a failed build finds what a delivery would.
      failedChecks: statuses.flatMap((status) => {
        const check = failedStatusCheck(status, head.headSha);
        return check ? [{ ...check, producer: statusProducer(status), trustedByDefault: false }] : [];
      }),
      reviews: comments
        .filter((comment) => comment.body.trim().length > 0)
        .map((comment) => ({ state: "commented" as const, author: comment.author, body: comment.body })),
    };
  }

  parsePullRequestUrl(url: URL): { repoPath: string; prNumber: number } | null {
    const host = url.host.toLowerCase();
    if (host !== "bitbucket.org" && host !== "www.bitbucket.org") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 4 || segments[2] !== "pull-requests") return null;
    const prNumber = Number(segments[3]);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
    return { repoPath: `${segments[0]}/${segments[1]}`, prNumber };
  }

  async getPRConflictStatus(prId: number): Promise<boolean> {
    // Redirects to the file conflicts of the pull request's revspec.
    const page = await this.client.json<{ values?: unknown[] }>(`${this.pr(prId)}/conflicts`);
    return (page.values ?? []).length > 0;
  }

  async listPRFiles(prId: number): Promise<PRFile[]> {
    const stats = await this.client.all<BitbucketDiffstat>(`${this.pr(prId)}/diffstat?pagelen=100`);
    // Redirects to the repository diff of the pull request's revspec, as text.
    const diff = await this.client.send(`${this.pr(prId)}/diff`, { headers: { Accept: "text/plain" } });
    const patches = diff.ok ? patchesByPath(await diff.text()) : new Map<string, string>();
    return stats.map((stat) => {
      const path = stat.new?.path ?? stat.old?.path ?? "";
      const file: PRFile = {
        path,
        additions: stat.lines_added ?? 0,
        deletions: stat.lines_removed ?? 0,
        changeType:
          stat.status === "added" || stat.status === "removed" || stat.status === "renamed"
            ? stat.status
            : "modified",
      };
      const patch = patches.get(path);
      if (patch !== undefined) file.patch = patch;
      return file;
    });
  }

  // ---------------------------------------------------------------------------
  // Comments and review threads

  private async allComments(prId: number): Promise<BitbucketComment[]> {
    return this.client.all<BitbucketComment>(`${this.pr(prId)}/comments?pagelen=100`);
  }

  async getPRComments(prId: number): Promise<PRComment[]> {
    const comments = await this.allComments(prId);
    return comments
      .filter((comment) => comment.deleted !== true && comment.pending !== true)
      .map((comment) => {
        const entry: PRComment = {
          author: accountLogin(comment.user, this.config.botLogin),
          body: String(comment.content?.raw ?? ""),
          // Bitbucket comments carry no reaction a run could read as "liked".
          liked: false,
        };
        const inline = comment.inline;
        if (inline?.path) {
          entry.filePath = inline.path;
          const end = inline.to ?? inline.from ?? undefined;
          const start = inline.start_to ?? inline.start_from ?? end;
          if (start !== undefined && start !== null) entry.startLine = start;
          if (end !== undefined && end !== null) entry.endLine = end;
        }
        return entry;
      });
  }

  async postPRComment(prId: number, body: string): Promise<{ url: string | null }> {
    const comment = await this.postComment(prId, body);
    return { url: comment.links?.html?.href ?? null };
  }

  private postComment(
    prId: number,
    body: string,
    extra: Record<string, unknown> = {},
  ): Promise<BitbucketComment> {
    return this.client.json<BitbucketComment>(`${this.pr(prId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { raw: body }, ...extra }),
    });
  }

  /** Resolve a thread by its top-level comment. Already resolved (409) is the
   *  answer a retry gets, and is what was wanted. */
  private async resolveThread(prId: number, rootId: number | string): Promise<void> {
    const path = `${this.pr(prId)}/comments/${rootId}/resolve`;
    const response = await this.client.send(path, { method: "POST" });
    if (response.ok || response.status === 409) return;
    throw await requestError(response, "POST", path);
  }

  /**
   * The token's own account UUID, read once per adapter. `GET /user` needs the
   * `account` scope, which only a workspace access token can carry; for any
   * other token this is `null` and the configured bot account decides alone.
   */
  private async selfUuid(): Promise<string | null> {
    if (this.cachedSelfUuid === undefined) {
      const response = await this.client.send("/user");
      const user = response.ok ? ((await response.json()) as BitbucketAccount) : null;
      this.cachedSelfUuid = user?.uuid ?? null;
    }
    return this.cachedSelfUuid;
  }

  private async ownership(): Promise<(account: BitbucketAccount | undefined) => boolean> {
    const uuid = await this.selfUuid();
    const botLogin = this.config.botLogin;
    return (account) => isOwnAccount(account, { uuid, botLogin });
  }

  /** Every thread, by its top-level comment, with live replies oldest first. */
  private threads(comments: BitbucketComment[]): CommentThread[] {
    const byId = new Map<number, BitbucketComment>();
    for (const comment of comments) if (typeof comment.id === "number") byId.set(comment.id, comment);
    const rootOf = (comment: BitbucketComment): BitbucketComment => {
      let current = comment;
      const seen = new Set<number>();
      while (typeof current.parent?.id === "number" && byId.has(current.parent.id) && !seen.has(current.parent.id)) {
        seen.add(current.parent.id);
        current = byId.get(current.parent.id)!;
      }
      return current;
    };
    const threads = new Map<number, CommentThread>();
    for (const comment of comments) {
      if (typeof comment.id !== "number") continue;
      const root = rootOf(comment);
      if (typeof root.id !== "number") continue;
      const thread = threads.get(root.id) ?? { root, notes: [] };
      if (comment.deleted !== true && comment.pending !== true) thread.notes.push(comment);
      threads.set(root.id, thread);
    }
    for (const thread of threads.values()) {
      thread.notes.sort((left, right) => parseTimestamp(left.created_on) - parseTimestamp(right.created_on));
    }
    return [...threads.values()];
  }

  /**
   * Every unresolved thread, as work items the ledger can hand to the agent. A
   * thread is a top-level comment and its replies; only a top-level comment can
   * be resolved (API reference, "Resolve a comment thread"), and it can be
   * whether or not anybody replied, so every thread is resolvable.
   */
  async listReviewThreads(prId: number): Promise<ReviewThreadFeed> {
    // Taken before the first request, so anything written while this reads is
    // newer than the snapshot.
    const snapshotAt = new Date().toISOString();
    const comments = await this.allComments(prId);
    const isOurs = await this.ownership();
    const reopened = new Set<string>();

    const mapped = this.threads(comments)
      .flatMap(({ root, notes }) => {
        if (root.deleted === true || root.pending === true) return [];
        if (root.resolution !== undefined && root.resolution !== null) return [];
        const first = notes[0];
        if (!first) return [];
        // Our own bookkeeping opened this thread (a failure note, a reply left
        // standing alone): read back, the next run would answer itself.
        if (isOurs(first.user) && isReviewLedgerNote(String(first.content?.raw ?? ""))) return [];
        const threadId = String(root.id);
        const ours = new Set<object>();
        const mappedNotes = notes.map((note) => {
          const mine = isOurs(note.user);
          const body = String(note.content?.raw ?? "");
          const entry = {
            author: accountLogin(note.user, this.config.botLogin),
            body,
            createdAt: String(note.created_on ?? ""),
            // A marker alone proves nothing: a reviewer quoting our reply back
            // would otherwise park the thread on a human already waiting.
            isLedgerReply: mine && readReviewLedgerMarker(body) !== null,
          };
          if (mine) ours.add(entry);
          return entry;
        });
        if (isReopenedLedgerThread(mappedNotes, (note) => ours.has(note))) reopened.add(threadId);
        const thread: ReviewThread = {
          threadId,
          alias: "",
          source: reviewThreadSource(root.user, isOurs),
          resolvable: true,
          awaitingHuman: mappedNotes.at(-1)?.isLedgerReply === true,
          notes: mappedNotes,
        };
        if (root.inline?.path) thread.filePath = root.inline.path;
        const line = root.inline?.to ?? root.inline?.from;
        if (typeof line === "number") thread.line = line;
        return [{ thread, openedAt: parseTimestamp(root.created_on) }];
      })
      .sort((left, right) => left.openedAt - right.openedAt)
      .map((entry) => entry.thread);

    const workItems = mapped.filter(isReviewLedgerWorkItem);
    const context = mapped.filter((thread) => !isReviewLedgerWorkItem(thread));
    const threads = [
      ...workItems.slice(0, REVIEW_LEDGER_MAX_WORK_ITEMS),
      ...context.slice(0, REVIEW_LEDGER_MAX_CONTEXT_THREADS),
    ];
    threads.forEach((thread, index) => {
      thread.alias = `T${index + 1}`;
    });
    for (const thread of threads) {
      if (!reopened.has(thread.threadId)) continue;
      this.config.log?.info(
        { event: "review_ledger.reopened", threadId: thread.threadId, alias: thread.alias },
        "review_ledger_reopened",
      );
    }
    return {
      threads,
      truncated: Math.max(0, workItems.length - REVIEW_LEDGER_MAX_WORK_ITEMS),
      contextTruncated: Math.max(0, context.length - REVIEW_LEDGER_MAX_CONTEXT_THREADS),
      snapshotAt,
    };
  }

  /**
   * Post the ledger's answer into one thread and, when the disposition earns
   * it, resolve it. The thread is read again first: between the snapshot and
   * now a reviewer may have written something nobody in this run has seen. The
   * same two guards as on GitLab, in the same order: our own reply already
   * there wins, then newer activity by anybody else makes the answer stale.
   */
  async settleReviewThread(input: SettleReviewThreadInput): Promise<SettleReviewThreadResult> {
    const { prId, thread, body, resolve, snapshotAt } = input;
    const rootId = Number(thread.threadId);
    if (!Number.isSafeInteger(rootId)) throw new FatalError(`Bitbucket thread id ${thread.threadId} is not a comment id`);
    const comments = await this.allComments(prId);
    const isOurs = await this.ownership();
    const current = this.threads(comments).find((candidate) => candidate.root.id === rootId);
    if (!current) throw new FatalError(`Bitbucket pull request #${prId} has no comment thread ${rootId}`);
    const notes = current.notes;

    const last = notes.at(-1);
    if (
      last !== undefined &&
      isOurs(last.user) &&
      readAnyReviewLedgerMarker(String(last.content?.raw ?? "")) === thread.threadId
    ) {
      return { action: "skipped_existing_reply" };
    }

    const postReply = (text: string) => this.postComment(prId, text, { parent: { id: rootId } });
    const snapshotInstant = parseTimestamp(snapshotAt);
    const movedSinceSnapshot = notes.some(
      (note) => !isOurs(note.user) && parseTimestamp(note.created_on) > snapshotInstant,
    );
    if (movedSinceSnapshot) {
      await postReply(markReviewLedgerReplyStale(body, thread.threadId));
      return { action: "replied_stale" };
    }
    if (!resolve) {
      await postReply(body);
      return { action: "replied" };
    }
    await postReply(markReviewLedgerReplyResolved(body, thread.threadId));
    await this.resolveThread(prId, rootId);
    return { action: "replied_and_resolved" };
  }

  /** Tell the pull request the ledger round died, once per run. */
  async postRunFailureNote(input: PostRunFailureNoteInput): Promise<void> {
    const { prId, runId, body } = input;
    const comments = await this.allComments(prId);
    const alreadyReported = comments.some(
      (comment) => comment.deleted !== true && hasReviewLedgerFailureMarker(String(comment.content?.raw ?? ""), runId),
    );
    if (alreadyReported) return;
    await this.postPRComment(prId, `${body}\n\n${reviewLedgerFailureMarker(runId)}`);
  }

  // ---------------------------------------------------------------------------
  // Published reviews

  /**
   * The same three artifacts as on GitLab, with the same lifetimes: one inline
   * thread per finding, opened once and carried across rounds and resolved as
   * soon as a round stops reporting it; one inline thread per finding new to
   * this round; one summary comment for the pull request, edited in place.
   * The decision is also recorded as an approval or a change request, best
   * effort, since Bitbucket refuses either for some accounts.
   */
  async publishPRReview(prId: number, publication: PRReviewPublication): Promise<PRReviewPublicationResult> {
    const marker = reviewSummaryMarker(publication.idempotencyKey);
    const priorKeys = publication.priorIdempotencyKeys ?? [];
    const knownMarkers = [marker, ...priorKeys.map(reviewSummaryMarker)];
    const headMarker = reviewHeadMarker(publication.headSha);
    const legacyCommentMarkers = (index: number) =>
      [publication.idempotencyKey, ...priorKeys].map((key) => legacyReviewCommentMarker(key, index));

    const comments = await this.allComments(prId);
    const live = comments.filter((comment) => comment.deleted !== true);
    const summary = live.find(
      (comment) =>
        comment.parent === undefined &&
        comment.inline === undefined &&
        knownMarkers.some((known) => String(comment.content?.raw ?? "").includes(known)),
    );
    const digests = publication.commentFindingDigests;
    const threads = this.threads(comments);
    // Ours only when marked with a finding digest AND written by this token's
    // account: the marker alone is text anybody can paste.
    const isOurs = threads.some(({ root }) => readReviewFindingDigest(String(root.content?.raw ?? "")))
      ? await this.ownership()
      : () => false;
    const owned = threads.flatMap(({ root, notes }): OwnedFindingThread[] => {
      const digest = readReviewFindingDigest(String(root.content?.raw ?? ""));
      if (digest === null || typeof root.id !== "number" || root.deleted === true || !isOurs(root.user)) return [];
      return [
        {
          rootId: root.id,
          digest,
          resolved: root.resolution !== undefined && root.resolution !== null,
          hasHumanReply: notes.some((note) => !isOurs(note.user)),
          hasSupersededNote: notes.some((note) => String(note.content?.raw ?? "").includes(SUPERSEDED_THREAD_NOTE)),
        },
      ];
    });
    const openByDigest = new Map(owned.map((entry) => [entry.digest, entry.rootId] as const));
    const reported = new Set([...digests, ...(publication.deferredFindingDigests ?? [])]);
    const openFor = (index: number): number | undefined =>
      openByDigest.get(digests[index]!) ??
      live.find(
        (comment) =>
          comment.parent === undefined &&
          legacyCommentMarkers(index).some((known) => String(comment.content?.raw ?? "").includes(known)),
      )?.id;
    const matched = publication.comments.map((_, index) => openFor(index));

    if (summary !== undefined && String(summary.content?.raw ?? "").includes(headMarker)) {
      // This head is already published: a retry only finishes what the first
      // attempt may not have (the decision, the sweep).
      await this.recordDecisionBestEffort(prId, publication.decision);
      await this.retireSupersededThreads(prId, owned, reported);
      return {
        id: summary.id === undefined ? publication.idempotencyKey : String(summary.id),
        commentIds: matched.map((id) => (id === undefined ? null : String(id))),
      };
    }

    const head = await this.readPullRequestHead(prId);
    if (head.head.headSha !== publication.headSha) {
      throw new FatalError(
        `Bitbucket pull request #${prId} no longer matches reviewed head ${publication.headSha}`,
      );
    }

    const commentIds: Array<string | null> = [];
    const summaryFallbacks: string[] = [];
    const carriedOver: PRReviewInlineComment[] = [];
    for (const [index, comment] of publication.comments.entries()) {
      const prior = matched[index];
      if (prior !== undefined) {
        commentIds.push(String(prior));
        carriedOver.push(comment);
        continue;
      }
      try {
        const posted = await this.postComment(prId, `${comment.body}\n\n${reviewFindingMarker(digests[index]!)}`, {
          inline: {
            path: comment.path,
            to: comment.endLine,
            ...(comment.startLine === comment.endLine ? {} : { start_to: comment.startLine }),
          },
        });
        commentIds.push(posted.id === undefined ? null : String(posted.id));
      } catch (error) {
        if (statusOf(error) !== 400) throw error;
        this.config.log?.warn(
          { path: comment.path, startLine: comment.startLine, endLine: comment.endLine },
          "bitbucket_inline_comment_refused",
        );
        commentIds.push(null);
        summaryFallbacks.push(reviewFallbackBullet(comment));
      }
    }

    const body = [
      publication.summary,
      ...(summaryFallbacks.length === 0
        ? []
        : [`### Additional findings not placed inline\n${summaryFallbacks.join("\n")}`]),
      ...(carriedOver.length === 0
        ? []
        : ["### Findings already open on this pull request\n" + carriedOver.map(reviewFallbackBullet).join("\n")]),
      marker,
      headMarker,
      // Read by the webhook to drop the comment event this summary produces.
      AI_WORKFLOW_COMMENT_MARKER,
    ].join("\n\n");
    const note =
      summary?.id === undefined
        ? await this.postComment(prId, body)
        : await this.client.json<BitbucketComment>(`${this.pr(prId)}/comments/${summary.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: { raw: body } }),
          });
    await this.recordDecisionBestEffort(prId, publication.decision);
    // Only once this round's findings are on the pull request: a failure
    // between a sweep and the summary would leave it reading reviewed and clean.
    await this.retireSupersededThreads(prId, owned, reported);
    return { id: note.id === undefined ? publication.idempotencyKey : String(note.id), commentIds };
  }

  /** Retire the threads whose finding this round no longer reports, with a note
   *  first so a failure in between leaves an explained open thread. */
  private async retireSupersededThreads(
    prId: number,
    owned: ReadonlyArray<OwnedFindingThread>,
    reported: ReadonlySet<string>,
  ): Promise<void> {
    for (const entry of owned) {
      if (entry.resolved || reported.has(entry.digest) || entry.hasHumanReply) continue;
      if (!entry.hasSupersededNote) {
        await this.postComment(prId, SUPERSEDED_THREAD_NOTE, { parent: { id: entry.rootId } });
      }
      await this.resolveThread(prId, entry.rootId);
    }
  }

  /**
   * The review's decision as Bitbucket's own approval or change request. Each
   * takes the place of the other, so the opposite one is withdrawn first. Best
   * effort: Bitbucket refuses an author's approval of their own pull request,
   * and a refused decision must never discard a review already published.
   */
  private async recordDecisionBestEffort(
    prId: number,
    decision: PRReviewPublication["decision"],
  ): Promise<void> {
    const [withdraw, record] =
      decision === "approve" ? ["request-changes", "approve"] : ["approve", "request-changes"];
    await this.client.send(`${this.pr(prId)}/${withdraw}`, { method: "DELETE" }).catch(() => null);
    const response = await this.client.send(`${this.pr(prId)}/${record}`, { method: "POST" }).catch(() => null);
    if (!response?.ok) {
      this.config.log?.warn(
        { prId, decision, status: response?.status ?? null },
        "bitbucket_review_decision_refused",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Gate statuses and Code Insights reports

  async createGateStatus(name: string, headSha: string): Promise<GateStatusRef> {
    const handle = { kind: "gate_status" as const, key: gateStatusKey(name), name, headSha };
    await this.postBuildStatus(handle, { state: "INPROGRESS" });
    return gateHandle(handle);
  }

  async updateGateStatus(ref: GateStatusRef, update: GateStatusUpdate): Promise<void> {
    const handle = readGateHandle(ref);
    await this.postBuildStatus(handle, {
      state: buildState(update),
      ...(update.summary !== undefined ? { description: clampBothEnds(update.summary, STATUS_DESCRIPTION_MAX) } : {}),
    });
  }

  /**
   * The status, plus a Code Insights report on the same commit under the same
   * key carrying the details and one annotation per finding. The report is
   * replaced rather than updated, so a finding a later update no longer
   * reports does not stay on it.
   */
  async updateGateStatusDetails(ref: GateStatusRef, update: RichGateStatusUpdate): Promise<void> {
    const handle = readGateHandle(ref);
    await this.updateGateStatus(ref, update);
    const report = `${this.repo}/commit/${handle.headSha}/reports/${encodeURIComponent(handle.key)}`;
    const removed = await this.client.send(report, { method: "DELETE" });
    if (!removed.ok && removed.status !== 404) throw await requestError(removed, "DELETE", report);
    await this.client.json(report, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: handle.name,
        details: clampBothEnds(update.details ?? update.summary ?? "", REPORT_DETAILS_MAX),
        report_type: "BUG",
        reporter: REPORTER,
        link: this.commitUrl(handle.headSha),
        result: reportResult(update),
      }),
    });
    const annotations = (update.annotations ?? []).slice(0, ANNOTATIONS_PER_REPORT);
    for (let start = 0; start < annotations.length; start += ANNOTATIONS_PER_REQUEST) {
      const chunk = annotations.slice(start, start + ANNOTATIONS_PER_REQUEST);
      await this.client.json(`${report}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map((annotation, offset) => toAnnotation(handle.key, start + offset, annotation))),
      });
    }
  }

  private commitUrl(sha: string): string {
    return `${BITBUCKET_WEB}/${this.config.repoPath}/commits/${sha}`;
  }

  /** Posting the same key on the same commit overwrites the status (API
   *  reference, "Create a build status for a commit"), so a retry or an update
   *  never adds a second one. */
  private async postBuildStatus(
    handle: BitbucketGateStatusHandle,
    status: { state: string; description?: string },
  ): Promise<void> {
    await this.client.json(`${this.repo}/commit/${handle.headSha}/statuses/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: handle.key, name: handle.name, url: this.commitUrl(handle.headSha), ...status }),
    });
  }

  async getCheckRunResults(prId: number): Promise<CheckRunResult[]> {
    const { statuses } = await this.readPullRequestHead(prId);
    return statuses.map((status) => {
      const { status: state, conclusion } = checkRunState(status.state);
      return { name: status.name || status.key || "build", status: state, conclusion };
    });
  }
}

function mapRepository(repository: BitbucketRepository): VcsRepositoryMetadata {
  const repoPath = repository.full_name!;
  return {
    provider: "bitbucket",
    repoPath,
    name: repository.name ?? repoPath.split("/")[1] ?? repoPath,
    owner: repository.workspace?.slug ?? repoPath.split("/")[0]!,
    defaultBranch: repository.mainbranch?.name ?? "",
    description: repository.description ?? "",
    webUrl: repository.links?.html?.href ?? `${BITBUCKET_WEB}/${repoPath}`,
    // Bitbucket repositories have no topics and cannot be archived.
    topics: [],
    archived: false,
    private: repository.is_private !== false,
  };
}

/**
 * "bot" is this workflow's own account; "third_party" an app account
 * (`app_user`, one of the three account kinds Bitbucket's event payloads name),
 * which is how another review bot speaks; anybody else is a person.
 */
function reviewThreadSource(
  author: BitbucketAccount | undefined,
  isOurs: (account: BitbucketAccount | undefined) => boolean,
): ReviewThreadSource {
  if (isOurs(author)) return "bot";
  return author?.type === "app_user" ? "third_party" : "human";
}

function statusOf(error: unknown): number | undefined {
  return providerAnswer(error)?.status;
}

/** A refusal of the values sent is final for this call; anything else,
 *  including a rate limit or Bitbucket failing on its side, is retried. */
function throwWithProviderRetrySemantics(error: unknown): never {
  if (readProviderFailure(error).kind === "refused") {
    throw new FatalError(error instanceof Error ? error.message : String(error));
  }
  throw error;
}

/** A stable status key for a gate check name: the same name on the same
 *  commit is the same status, so a retry overwrites rather than duplicates. */
function gateStatusKey(name: string): string {
  return `aiw-${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;
}

function readGateHandle(ref: GateStatusRef): BitbucketGateStatusHandle {
  const value = ref as unknown as Partial<BitbucketGateStatusHandle>;
  if (
    value.kind !== "gate_status" ||
    typeof value.key !== "string" ||
    typeof value.name !== "string" ||
    typeof value.headSha !== "string"
  ) {
    throw new Error("Bitbucket received an invalid gate status handle");
  }
  return value as BitbucketGateStatusHandle;
}

/** A gate update in Bitbucket's four build states. Neutral and skipped are
 *  not failures, so they read successful, as a skipped check does on GitHub. */
function buildState(update: GateStatusUpdate): "INPROGRESS" | "SUCCESSFUL" | "FAILED" | "STOPPED" {
  if (update.status === "in_progress") return "INPROGRESS";
  switch (update.conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "SUCCESSFUL";
    case "cancelled":
      return "STOPPED";
    case "failure":
    case "timed_out":
    case "action_required":
      return "FAILED";
    default:
      return "INPROGRESS";
  }
}

function reportResult(update: GateStatusUpdate): "PASSED" | "FAILED" | "PENDING" {
  const state = buildState(update);
  if (state === "SUCCESSFUL") return "PASSED";
  if (state === "INPROGRESS") return "PENDING";
  return "FAILED";
}

function toAnnotation(key: string, index: number, annotation: CheckRunAnnotation) {
  const summary = annotation.title ? `${annotation.title}: ${annotation.message}` : annotation.message;
  return {
    external_id: `${key}-${index + 1}`,
    annotation_type: "BUG",
    path: annotation.path,
    // An annotation sits on one line; a range is placed at its first line.
    line: annotation.startLine,
    summary: clampBothEnds(summary, ANNOTATION_SUMMARY_MAX),
    ...(annotation.rawDetails ? { details: clampBothEnds(annotation.rawDetails, REPORT_DETAILS_MAX) } : {}),
    severity:
      annotation.annotationLevel === "failure" ? "HIGH" : annotation.annotationLevel === "warning" ? "MEDIUM" : "LOW",
    result: "FAILED",
  };
}

function checkRunState(state: string | undefined): Pick<CheckRunResult, "status" | "conclusion"> {
  switch (state) {
    case "SUCCESSFUL":
      return { status: "completed", conclusion: "success" };
    case "FAILED":
      return { status: "completed", conclusion: "failure" };
    case "STOPPED":
      return { status: "completed", conclusion: "cancelled" };
    case "INPROGRESS":
      return { status: "in_progress", conclusion: null };
    default:
      return { status: "queued", conclusion: null };
  }
}

/**
 * Each file's hunks out of a unified diff, keyed by the file's path (the new
 * one, or the old one for a deleted file), without the `diff --git` and
 * `---`/`+++` headers: the patch starts at its first `@@`, as the other
 * providers' patches do. A binary file has no hunk and gets no patch.
 */
export function patchesByPath(diff: string): Map<string, string> {
  const patches = new Map<string, string>();
  const sections = diff.split(/^(?=diff --git )/mu);
  for (const section of sections) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/mu.exec(section);
    if (!header) continue;
    const lines = section.split("\n");
    const deleted = lines.some((line) => line === "+++ /dev/null");
    const path = deleted ? header[1]! : header[2]!;
    const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
    if (firstHunk < 0) continue;
    patches.set(path, lines.slice(firstHunk).join("\n").replace(/\n+$/u, ""));
  }
  return patches;
}

function clampBothEnds(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const marker = " ... ";
  const remaining = Math.max(0, maxLength - marker.length);
  const head = Math.ceil(remaining / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (remaining - head))}`;
}

/** Bitbucket timestamps are ISO 8601 with an offset; compare instants. */
function parseTimestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}
