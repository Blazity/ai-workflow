import { FatalError } from "workflow";
import type { Octokit } from "@octokit/rest";
import { buildOctokit, type GitHubAppAuth } from "../../lib/github-auth.js";
import { logger } from "../../lib/logger.js";
import type {
  VCSAdapter,
  GateStatusUpdate,
  GateStatusCapableVCS,
  GateStatusRef,
  PRFile,
  PRFilesCapableVCS,
  PRReviewCapableVCS,
  PRReviewInlineComment,
  PRReviewPublication,
  PRReviewPublicationResult,
  PullRequest,
  PRComment,
  CheckRunResult,
  PullRequestHead,
  RichGateStatusCapableVCS,
  RichGateStatusUpdate,
  ManualDispatchPrCapableVCS,
  ManualDispatchPullRequestSnapshot,
  ReviewThread,
  ReviewThreadFeed,
  ReviewThreadNote,
  ReviewThreadSource,
  SettleReviewThreadInput,
  SettleReviewThreadResult,
  PostRunFailureNoteInput,
} from "./types.js";
import {
  isReviewLedgerWorkItem,
  readReviewFindingDigest,
  reviewFallbackBullet,
  REVIEW_LEDGER_MAX_CONTEXT_THREADS,
  REVIEW_LEDGER_MAX_WORK_ITEMS,
} from "./types.js";
import {
  AI_WORKFLOW_COMMENT_MARKER,
  hasReviewLedgerFailureMarker,
  isReopenedLedgerThread,
  isReviewLedgerNote,
  markReviewLedgerReplyResolved,
  markReviewLedgerReplyStale,
  readAnyReviewLedgerMarker,
  readReviewLedgerMarker,
  reviewLedgerFailureMarker,
  vcsLoginsMatch,
} from "../../lib/vcs-bot-identity.js";

export interface GitHubConfig {
  auth: GitHubAppAuth;
  owner: string;
  repo: string;
  baseBranch: string;
}

function isSelfAuthoredReviewError(error: unknown): boolean {
  const candidate = error as {
    status?: unknown;
    message?: unknown;
    response?: {
      data?: {
        message?: unknown;
        errors?: unknown;
      };
    };
  };
  if (candidate.status !== 422) return false;

  const details = [
    candidate.message,
    candidate.response?.data?.message,
    candidate.response?.data?.errors === undefined
      ? undefined
      : JSON.stringify(candidate.response.data.errors),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  return /review can not (?:request changes on|approve) your own pull request/i.test(
    details,
  );
}

/** The marker family is this adapter's; the digest inside it comes from the caller. */
function reviewFindingMarker(digest: string): string {
  return `<!-- ai-workflow-review-finding:${digest} -->`;
}

/**
 * The body of the review that carries a round's verdict, and it deliberately does
 * not carry the summary.
 *
 * GitHub has no way to change a submitted review's verdict: `pulls.updateReview`
 * rewrites the body and nothing else. So a summary kept in a review body is frozen
 * at whichever verdict the first round reached, and a first round that requested
 * changes would keep blocking the merge after every later round approved. The
 * verdict therefore stays one review per round, and the summary moves to the one
 * pull-request comment this adapter rewrites in place.
 */
function roundReviewBody(headMarker: string, sections: string[] = []): string {
  return [
    "## AI Workflow review",
    "The findings for this commit are the inline comments below. The full review " +
      "summary is kept in a single comment on this pull request and is rewritten " +
      "on every round.",
    ...sections,
    headMarker,
  ].join("\n\n");
}

/**
 * The whole thread, not just its opening comment: whether a HUMAN has replied is
 * what decides if this workflow may touch the thread at all, and that answer lives
 * in the comments after the first one.
 *
 * `first: 100` and no inner pagination. A review thread with more than a hundred
 * comments is a conversation this workflow should keep its hands off regardless,
 * and the guard below fails safe in exactly that direction: unread replies can only
 * make a thread look more human-touched, never less.
 */
const REVIEW_THREADS_QUERY = `
  query reviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            comments(first: 100) {
              nodes { id databaseId body viewerDidAuthor isMinimized }
            }
          }
        }
      }
    }
  }
`;

/**
 * The one act this workflow performs on a thread it has moved past, and it is
 * deliberately NOT `resolveReviewThread`.
 *
 * "Resolved" is a claim about the code: that the defect is gone. Nothing here can
 * support that claim. A finding's identity is a hash of agent-authored prose that is
 * regenerated every round with no canonicalisation, so a thread going unmatched
 * means "this round did not report the same wording", which is not "the defect was
 * fixed". Marking it resolved on that evidence puts a green tick on live defects.
 *
 * `OUTDATED` is true whenever it is applied: the thread was opened against an
 * earlier commit and the round has moved on. It collapses the comment in the
 * conversation, which is the tidying this ticket wanted, and it asserts nothing
 * about whether the code was repaired.
 * https://docs.github.com/graphql, Mutation.minimizeComment.
 */
const MINIMIZE_COMMENT_MUTATION = `
  mutation minimizeComment($subjectId: ID!) {
    minimizeComment(input: { subjectId: $subjectId, classifier: OUTDATED }) {
      minimizedComment { isMinimized }
    }
  }
`;

/**
 * The review ledger's own view of a pull request's threads.
 *
 * Deliberately a second document rather than more fields on
 * `REVIEW_THREADS_QUERY`: that one answers "which threads did this workflow
 * open", its result shape is consumed by the review sweep, and widening it would
 * make one query serve two unrelated ownership rules.
 *
 * `first: 100` on the comments and no inner pagination, same trade as above: a
 * thread past a hundred comments reads as more human-touched than it is, and that
 * is the direction this feature must fail in.
 */
const LEDGER_REVIEW_THREADS_QUERY = `
  query ledgerReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            path
            line
            comments(first: 100) {
              nodes {
                id
                databaseId
                body
                createdAt
                isMinimized
                viewerDidAuthor
                author { login __typename }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * The login the current token posts under. REST issue comments carry no
 * `viewerDidAuthor`, so this is the only way to tell our own general comment from
 * a third party's.
 */
const LEDGER_VIEWER_QUERY = `
  query ledgerViewer {
    viewer { login }
  }
`;

/**
 * One thread, re-read at settle time. The feed's snapshot is minutes old by then,
 * and what has to be decided (has a human spoken since?) is exactly the thing that
 * can have changed in the meantime.
 */
const LEDGER_REVIEW_THREAD_NODE_QUERY = `
  query ledgerReviewThreadNode($threadId: ID!) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        isResolved
        comments(first: 100) {
          nodes {
            databaseId
            body
            createdAt
            viewerDidAuthor
            author { login }
          }
        }
      }
    }
  }
`;

/**
 * Resolving a ledger thread is a claim the workflow can actually support: the
 * agent reported the finding fixed and the reply carries the diff it stands on.
 * That is what separates this from `MINIMIZE_COMMENT_MUTATION`, which retires a
 * thread nobody has proven anything about.
 */
const RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation ledgerResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

interface LedgerReviewComment {
  id?: string | null;
  databaseId?: number | null;
  body?: string | null;
  createdAt?: string | null;
  isMinimized?: boolean | null;
  viewerDidAuthor?: boolean | null;
  author?: { login?: string | null; __typename?: string | null } | null;
}

interface LedgerReviewThreadNode {
  id?: string | null;
  isResolved?: boolean | null;
  path?: string | null;
  line?: number | null;
  comments?: { nodes?: Array<LedgerReviewComment | null> | null } | null;
}

interface LedgerReviewThreadsPage {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
        nodes?: Array<LedgerReviewThreadNode | null> | null;
      } | null;
    } | null;
  } | null;
}

/** An issue comment or a review summary, before it becomes a thread. */
interface LedgerGeneralComment {
  threadId: string;
  author: string;
  isViewer: boolean;
  isProviderBot: boolean;
  body: string;
  createdAt: string;
}

/** A thread before the feed assigns it an alias. */
type LedgerDraftThread = Omit<ReviewThread, "alias">;

/**
 * Who a thread belongs to, from the first note only. Later notes say who joined
 * the conversation, not who owns it, and a thread the bot opened stays the bot's
 * even after a reviewer answers in it.
 *
 * `viewerDidAuthor` rather than a login match: it is the provider's own answer to
 * "was this written by the token I am holding", so it survives an installation
 * being renamed and cannot be spoofed by a lookalike account.
 */
function ledgerInlineSource(comment: LedgerReviewComment): ReviewThreadSource {
  if (comment.viewerDidAuthor === true) return "bot";
  return comment.author?.__typename === "Bot" ? "third_party" : "human";
}

/**
 * The opening line of the comment being answered, quoted. A comment on the pull
 * request itself carries no threading, so without the quote a reader lands on a
 * bare reply with no way to tell which comment it answers. Empty when the
 * comment is gone: a bare "> " quotes nothing and only looks broken.
 */
function ledgerQuote(original: string): string {
  const line = (original.split(/\r?\n/)[0] ?? "").slice(0, 200);
  return line.trim() ? `> ${line}` : "";
}

function ledgerFirstNoteAt(thread: LedgerDraftThread): string {
  return thread.notes[0]?.createdAt ?? "";
}

/**
 * Orders the drafts, caps them and stamps the aliases. Aliases are positional and
 * gapless by construction: the agent answers by alias, so a gap or a reordering
 * between two reads of the same pull request would land a disposition on the
 * wrong thread.
 */
function buildReviewThreadFeed(
  drafts: LedgerDraftThread[],
  snapshotAt: string,
): ReviewThreadFeed {
  const byAge = (a: LedgerDraftThread, b: LedgerDraftThread) =>
    ledgerFirstNoteAt(a).localeCompare(ledgerFirstNoteAt(b));
  const workItems = drafts.filter(isReviewLedgerWorkItem).sort(byAge);
  const context = drafts.filter((draft) => !isReviewLedgerWorkItem(draft)).sort(byAge);
  const kept = workItems.slice(0, REVIEW_LEDGER_MAX_WORK_ITEMS);
  const keptContext = context.slice(0, REVIEW_LEDGER_MAX_CONTEXT_THREADS);
  const threads = [...kept, ...keptContext].map((draft, index) => ({
    ...draft,
    alias: `T${index + 1}`,
  }));
  // Counted apart, because they cost different things: a dropped work item is a
  // review comment the agent will never answer, a dropped context thread is
  // background it will not have.
  return {
    threads,
    truncated: workItems.length - kept.length,
    contextTruncated: context.length - keptContext.length,
    snapshotAt,
  };
}

interface ReviewThreadsConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: Array<{
    id?: string;
    comments?: {
      nodes?: Array<{
        id?: string;
        databaseId?: number | null;
        body?: string | null;
        viewerDidAuthor?: boolean;
        isMinimized?: boolean;
      } | null> | null;
    } | null;
  } | null> | null;
}

interface ReviewThreadsPage {
  repository?: {
    pullRequest?: { reviewThreads?: ReviewThreadsConnection | null } | null;
  } | null;
}

interface OwnedReviewThread {
  id: string;
  isMinimized: boolean;
  /** Node id of the thread's first comment, the subject `minimizeComment` takes. */
  commentId: string;
  commentReference: string | null;
  digest: string;
  /**
   * Somebody other than this workflow has commented in the thread. Such a thread is
   * never touched: a reader's question collapsed under an OUTDATED tick is a worse
   * outcome than a stale thread left open.
   */
  hasHumanReply: boolean;
}

export class GitHubAdapter
  implements
    VCSAdapter,
    GateStatusCapableVCS,
    RichGateStatusCapableVCS,
    PRFilesCapableVCS,
    PRReviewCapableVCS,
    ManualDispatchPrCapableVCS
{
  private octokit: Octokit;
  /** `undefined` until looked up; `null` when GitHub returned no login. */
  private cachedViewerLogin: string | null | undefined;

  constructor(private config: GitHubConfig) {
    this.octokit = buildOctokit(config.auth);
  }

  private get ownerRepo() {
    return { owner: this.config.owner, repo: this.config.repo };
  }

  async createBranchIfMissing(
    name: string,
    base: string,
  ): Promise<"created" | "existing"> {
    const baseSha = await this.resolveBranchBaseSha(base);
    try {
      await this.octokit.git.createRef({
        ...this.ownerRepo,
        ref: `refs/heads/${name}`,
        sha: baseSha,
      });
      return "created";
    } catch (err: any) {
      // Only a 422 that reports the ref already exists is the idempotent
      // "existing" case. Other 422s (invalid ref name, missing base object) are
      // real failures and must throw. Mirrors gitlab.ts's "already exists" match.
      if (err.status === 422 && /already exists/i.test(String(err?.message ?? ""))) {
        return "existing";
      }
      throw err;
    }
  }

  async resetOwnedBranch(name: string, base: string): Promise<void> {
    const baseSha = await this.resolveBranchBaseSha(base);
    await this.octokit.git.updateRef({
      ...this.ownerRepo,
      ref: `heads/${name}`,
      sha: baseSha,
      force: true,
    });
  }

  private async resolveBranchBaseSha(base: string): Promise<string> {
    // A 40-character hex string is already a commit SHA (for example the
    // research baseline a write branch must be cut from). Use it directly
    // instead of resolving it as a branch name, which would 404.
    if (/^[0-9a-f]{40}$/i.test(base)) return base;
    let baseSha: string;
    try {
      const ref = await this.octokit.git.getRef({
        ...this.ownerRepo,
        ref: `heads/${base}`,
      });
      baseSha = ref.data.object.sha;
    } catch (err: any) {
      if (err.status === 409) {
        baseSha = await this.seedEmptyRepo();
      } else {
        throw err;
      }
    }
    return baseSha;
  }

  private async seedEmptyRepo(): Promise<string> {
    try {
      const result = await this.octokit.repos.createOrUpdateFileContents({
        ...this.ownerRepo,
        path: "README.md",
        message: "Initial commit",
        content: Buffer.from("# Repository\n").toString("base64"),
      });
      return result.data.commit.sha!;
    } catch (err: any) {
      throw new Error(
        `Failed to seed empty repository ${this.config.owner}/${this.config.repo}: ${err.message}`,
      );
    }
  }

  async createPR(
    branch: string,
    title: string,
    body: string,
  ): Promise<PullRequest> {
    try {
      const { data } = await this.octokit.pulls.create({
        ...this.ownerRepo,
        head: branch,
        base: this.config.baseBranch,
        title,
        body,
      });
      return { id: data.number, url: data.html_url, branch };
    } catch (err: any) {
      // 422 (validation: PR already exists, branch missing) and 404 are non-retryable.
      // 401/403 (token expired, rate limit) are transient and should be retried.
      if (err.status === 422 || err.status === 404) {
        throw new FatalError(err.message);
      }
      throw err;
    }
  }

  async push(
    branch: string,
    files: Array<{ path: string; content: string }>,
    options?: { mergeParentSha?: string; message?: string },
  ): Promise<void> {
    const { data: refData } = await this.octokit.git.getRef({
      ...this.ownerRepo,
      ref: `heads/${branch}`,
    });
    const latestCommitSha = refData.object.sha;

    const { data: commitData } = await this.octokit.git.getCommit({
      ...this.ownerRepo,
      commit_sha: latestCommitSha,
    });

    const treeItems = await Promise.all(
      files.map(async (file) => {
        const { data: blob } = await this.octokit.git.createBlob({
          ...this.ownerRepo,
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
        });
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blob.sha,
        };
      }),
    );

    const { data: tree } = await this.octokit.git.createTree({
      ...this.ownerRepo,
      base_tree: commitData.tree.sha,
      tree: treeItems,
    });

    // When mergeParentSha is set, create a merge commit with two parents.
    // This tells GitHub the branch histories have been reconciled, clearing
    // the "has conflicts" status on the PR.
    const parents = options?.mergeParentSha
      ? [latestCommitSha, options.mergeParentSha]
      : [latestCommitSha];

    const { data: newCommit } = await this.octokit.git.createCommit({
      ...this.ownerRepo,
      message:
        options?.message ??
        (options?.mergeParentSha
          ? "merge: resolve conflicts with base branch"
          : "feat: agent implementation"),
      tree: tree.sha,
      parents,
    });

    await this.octokit.git.updateRef({
      ...this.ownerRepo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });
  }

  async getBranchSha(branch: string): Promise<string> {
    const { data } = await this.octokit.git.getRef({
      ...this.ownerRepo,
      ref: `heads/${branch}`,
    });
    return data.object.sha;
  }

  async getBranchShaIfExists(branch: string): Promise<string | null> {
    try {
      return await this.getBranchSha(branch);
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  async getPRHead(prId: number): Promise<PullRequestHead> {
    const { data } = await this.octokit.pulls.get({
      ...this.ownerRepo,
      pull_number: prId,
    });
    const baseRef = data.base.ref?.trim();
    if (!baseRef) throw new Error(`GitHub PR #${prId} is missing its target branch`);
    const state = data.merged === true ? "merged" : data.state;
    if (state !== "open" && state !== "closed" && state !== "merged") {
      throw new Error(`GitHub PR #${prId} has unsupported lifecycle state ${String(state)}`);
    }
    return { headSha: data.head.sha, headRef: data.head.ref, baseRef, state };
  }

  async getManualDispatchPullRequest(
    prId: number,
  ): Promise<ManualDispatchPullRequestSnapshot> {
    const { data } = await this.octokit.pulls.get({
      ...this.ownerRepo,
      pull_number: prId,
    });
    const baseRef = data.base.ref?.trim();
    if (!baseRef) throw new Error(`GitHub PR #${prId} is missing its target branch`);
    const state = data.merged === true ? "merged" : data.state;
    if (state !== "open" && state !== "closed" && state !== "merged") {
      throw new Error(`GitHub PR #${prId} has unsupported lifecycle state ${String(state)}`);
    }
    const [checks, reviews] = await Promise.all([
      this.getLatestCheckRuns(data.head.sha),
      this.octokit.paginate(this.octokit.pulls.listReviews, {
        ...this.ownerRepo,
        pull_number: prId,
        per_page: 100,
      }),
    ]);
    const failedChecks = checks
      .filter(
        (check) =>
          check.status === "completed" &&
          (check.conclusion === "failure" || check.conclusion === "timed_out"),
      )
      .map((check) => ({
        name: check.name,
        conclusion: check.conclusion!,
        checkRunId: check.id,
        appSlug: check.appSlug,
      }));
    return {
      prNumber: prId,
      prUrl: data.html_url,
      headRef: data.head.ref,
      headSha: data.head.sha,
      baseRef,
      title: data.title,
      author: data.user?.login ?? "unknown",
      isDraft: data.draft === true,
      state,
      ...(state === "merged" && data.merge_commit_sha
        ? { mergeSha: data.merge_commit_sha }
        : {}),
      ...(state === "merged" && data.merged_at
        ? { mergedAt: data.merged_at }
        : {}),
      failedChecks,
      reviews: reviews.flatMap((review) => {
        const reviewState =
          review.state === "CHANGES_REQUESTED"
            ? "changes_requested"
            : review.state === "COMMENTED"
              ? "commented"
              : null;
        return reviewState
          ? [{
              state: reviewState,
              author: review.user?.login ?? "unknown",
              body: review.body ?? "",
            }]
          : [];
      }),
    };
  }

  async getLatestCheckRuns(headSha: string) {
    const checkRuns = await this.octokit.paginate(
      this.octokit.checks.listForRef,
      {
        ...this.ownerRepo,
        ref: headSha,
        filter: "latest",
        per_page: 100,
      },
    );
    return checkRuns.map((check) => ({
      id: check.id,
      name: check.name,
      appSlug: check.app?.slug ?? "",
      status: check.status,
      conclusion: check.conclusion ?? null,
    }));
  }

  async getPRComments(prId: number): Promise<PRComment[]> {
    // Paginate all three: a PR with many comments/reviews would otherwise drop
    // feedback past the first page (default 30), silently starving the agent.
    const reviewComments = await this.octokit.paginate(
      this.octokit.pulls.listReviewComments,
      { ...this.ownerRepo, pull_number: prId, per_page: 100 },
    );
    const issueComments = await this.octokit.paginate(this.octokit.issues.listComments, {
      ...this.ownerRepo,
      issue_number: prId,
      per_page: 100,
    });
    // The review's own summary body ("Request Changes" / "Comment" text typed in
    // the main review box) lives on the review object, not on listReviewComments
    // (those are only the line-anchored inline notes). Without this, a review
    // carrying only a summary is invisible to the agent.
    const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
      ...this.ownerRepo,
      pull_number: prId,
      per_page: 100,
    });

    const comments: PRComment[] = [
      ...reviewComments.map((c) => ({
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        liked: (c.reactions?.total_count ?? 0) > 0,
        filePath: c.path,
        startLine: c.start_line ?? c.line,
        endLine: c.line,
      })),
      ...issueComments.map((c) => ({
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        liked: (c.reactions?.total_count ?? 0) > 0,
      })),
      ...reviews
        .filter((r) => (r.body ?? "").trim().length > 0)
        .map((r) => ({
          author: r.user?.login ?? "unknown",
          body: `[Review: ${formatReviewState(r.state)}] ${r.body}`,
          liked: false,
        })),
    ];
    return comments;
  }

  async postPRComment(prId: number, body: string): Promise<{ url: string | null }> {
    const { data } = await this.octokit.issues.createComment({
      ...this.ownerRepo,
      issue_number: prId,
      body,
    });
    return { url: data.html_url ?? null };
  }

  async getCheckRunResults(prId: number): Promise<CheckRunResult[]> {
    const { data: pr } = await this.octokit.pulls.get({
      ...this.ownerRepo,
      pull_number: prId,
    });
    const headSha = pr.head.sha;

    const { data: checksData } = await this.octokit.checks.listForRef({
      ...this.ownerRepo,
      ref: headSha,
    });

    const results: CheckRunResult[] = [];
    for (const check of checksData.check_runs) {
      const entry: CheckRunResult = {
        name: check.name,
        status: check.status as CheckRunResult["status"],
        conclusion: check.conclusion ?? null,
      };

      if (
        check.status === "completed" &&
        check.conclusion !== "success" &&
        check.conclusion !== null
      ) {
        try {
          // Find the matching workflow job and fetch its logs
          const runs =
            await this.octokit.actions.listWorkflowRunsForRepo({
              ...this.ownerRepo,
              head_sha: headSha,
            });

          for (const run of runs.data.workflow_runs) {
            const { data: jobs } =
              await this.octokit.actions.listJobsForWorkflowRun({
                ...this.ownerRepo,
                run_id: run.id,
              });

            const matchingJob = jobs.jobs.find((j) => j.name === check.name);
            if (matchingJob) {
              const { data: logData } =
                await this.octokit.actions.downloadJobLogsForWorkflowRun({
                  ...this.ownerRepo,
                  job_id: matchingJob.id,
                });
              entry.logs = String(logData);
              break;
            }
          }
        } catch {
          // Non-GitHub-Actions checks (CircleCI, Jenkins, etc.) won't have logs
        }
      }

      results.push(entry);
    }

    return results;
  }

  async getPRConflictStatus(prId: number): Promise<boolean> {
    const { data } = await this.octokit.pulls.get({
      ...this.ownerRepo,
      pull_number: prId,
    });
    return data.mergeable === false;
  }

  async getPRHeadSha(prId: number): Promise<string> {
    const { data } = await this.octokit.pulls.get({
      ...this.ownerRepo,
      pull_number: prId,
    });
    return data.head.sha;
  }

  async findPR(branch: string): Promise<PullRequest | null> {
    const { data } = await this.octokit.pulls.list({
      ...this.ownerRepo,
      head: `${this.config.owner}:${branch}`,
      base: this.config.baseBranch,
      state: "open",
    });
    if (data.length === 0) return null;
    const pr = data[0];
    return { id: pr.number, url: pr.html_url, branch: pr.head.ref };
  }

  async listPRFiles(prId: number): Promise<PRFile[]> {
    const files = await this.octokit.paginate(this.octokit.pulls.listFiles, {
      ...this.ownerRepo,
      pull_number: prId,
      per_page: 100,
    });
    return files.map((f) => ({
      path: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      changeType: mapFileStatus(f.status),
      patch: f.patch,
    }));
  }

  /**
   * Three artifacts with three different lifetimes, which is what keeps a pull
   * request from collecting a round's worth of everything on every push:
   *
   *  - one THREAD per finding, opened once and carried across rounds, marked
   *    resolved and hidden as soon as the round stops reporting it;
   *  - one inline comment per finding that is NEW to this round, so a finding
   *    already under discussion is not restated;
   *  - one SUMMARY comment for the whole pull request, rewritten in place.
   *
   * The verdict is the exception and stays one review per round, because GitHub
   * cannot revise a submitted review's verdict (see `roundReviewBody`).
   */
  async publishPRReview(
    prId: number,
    publication: PRReviewPublication,
  ): Promise<PRReviewPublicationResult> {
    const reviewMarker = (key: string) => `<!-- ai-workflow-review:${key} -->`;
    const marker = reviewMarker(publication.idempotencyKey);
    // The pull request's marker, on the one summary comment. Only `marker` is ever
    // written; the prior keys are recognised as well because a summary published
    // before the key identified the pull request carries one of those, and missing
    // it would leave that one behind and add a second summary next to it.
    const knownMarkers = [
      marker,
      ...(publication.priorIdempotencyKeys ?? []).map(reviewMarker),
    ];
    // The round's marker, on the review that carries the verdict. This is what
    // makes a retry at one head submit one verdict and not two, now that the
    // summary marker no longer says which head it describes.
    const headMarker = `<!-- ai-workflow-review-head:${publication.headSha} -->`;

    const threads = await this.ownReviewThreads(prId);
    // The caller's digests. This adapter only carries the value.
    const digests = publication.commentFindingDigests;
    // Reported inline AND reported into the summary. A finding the cap pushed out
    // of the inline set is still standing, so its thread must not be collapsed as
    // outdated while the summary lists it: the two would say opposite things about
    // one defect, which is the misleading state this whole change is about.
    const reported = new Set([
      ...digests,
      ...(publication.deferredFindingDigests ?? []),
    ]);
    const openByDigest = new Map<string, OwnedReviewThread>();
    for (const thread of threads) {
      openByDigest.set(thread.digest, thread);
    }

    const carriedOver = new Map<number, string | null>();
    const fresh: PRReviewInlineComment[] = [];
    const freshIndexes: number[] = [];
    publication.comments.forEach((comment, index) => {
      const open = openByDigest.get(digests[index]!);
      if (open) {
        carriedOver.set(index, open.commentReference);
        return;
      }
      fresh.push(comment);
      freshIndexes.push(index);
    });

    const existing = await this.octokit.paginate(this.octokit.pulls.listReviews, {
      ...this.ownerRepo,
      pull_number: prId,
      per_page: 100,
    });
    // Prior keys are matched here too: a review published under the old scheme
    // carried the round in this marker family, and it is the only record that the
    // head it named was already reviewed.
    const roundMarkers = [
      headMarker,
      ...(publication.priorIdempotencyKeys ?? []).map(reviewMarker),
    ];
    const prior = existing.find((review) =>
      roundMarkers.some((known) => review.body?.includes(known)),
    );

    const commentIdsFor = (published: Array<string | null> | null) =>
      publication.comments.map((_, index) => {
        if (carriedOver.has(index)) return carriedOver.get(index) ?? null;
        if (published === null) return null;
        return published[freshIndexes.indexOf(index)] ?? null;
      });

    const finish = async (
      reviewId: string,
      published: Array<string | null> | null,
    ): Promise<PRReviewPublicationResult> => {
      // Only ever after a review for this round exists on the pull request. Run
      // before publication, a failing createReview left every earlier thread
      // collapsed with no new review to replace them, and the pull request read as
      // reviewed and clean. Every caller of `finish` is past that point, including
      // the retry that found the round already published.
      for (const thread of threads) {
        if (reported.has(thread.digest)) continue;
        if (thread.isMinimized) continue;
        // Somebody is talking in this thread. Leave it exactly as it is.
        if (thread.hasHumanReply) continue;
        await this.retireReviewThread(thread);
      }
      await this.upsertReviewSummary(prId, knownMarkers, [
        publication.summary,
        ...this.carriedOverSummarySection(publication.comments, carriedOver),
        marker,
      ]);
      return { id: reviewId, commentIds: commentIdsFor(published) };
    };

    if (prior) {
      // This head already has its verdict. Everything else still runs: the
      // publish call can succeed and the state update that records it can be
      // lost, so a retry has to be able to finish resolving threads and writing
      // the summary rather than treating the review's existence as proof they
      // happened.
      const comments = await this.octokit.paginate(
        this.octokit.pulls.listCommentsForReview,
        {
          ...this.ownerRepo,
          pull_number: prId,
          review_id: prior.id,
          per_page: 100,
        },
      );
      return finish(
        String(prior.id),
        this.alignReviewCommentIds(fresh, comments),
      );
    }
    const request: Parameters<Octokit["pulls"]["createReview"]>[0] = {
      ...this.ownerRepo,
      pull_number: prId,
      commit_id: publication.headSha,
      event:
        publication.decision === "approve"
          ? ("APPROVE" as const)
          : ("REQUEST_CHANGES" as const),
      body: roundReviewBody(headMarker),
      comments: fresh.map((comment, index) => ({
        path: comment.path,
        // The marker travels with the comment because the thread it opens is what
        // a later round has to recognise. GitHub returns comment bodies verbatim,
        // so this is the anchor that survives a push. The digest is the caller's,
        // never re-derived here, or the thread would be opened under one identity
        // and looked up under another.
        body: `${comment.body}\n\n${reviewFindingMarker(digests[freshIndexes[index]!]!)}`,
        side: "RIGHT" as const,
        line: comment.endLine,
        ...(comment.startLine !== comment.endLine
          ? {
              start_side: "RIGHT" as const,
              start_line: comment.startLine,
            }
          : {}),
      })),
    };
    let data: { id: number };
    let publishedRequest = request;
    try {
      ({ data } = await this.octokit.pulls.createReview(publishedRequest));
    } catch (error) {
      if (isSelfAuthoredReviewError(error)) {
        publishedRequest = {
          ...request,
          event: "COMMENT" as const,
        };
        try {
          ({ data } =
            await this.octokit.pulls.createReview(publishedRequest));
        } catch (commentError) {
          if (
            (commentError as { status?: unknown }).status !== 422 ||
            fresh.length === 0
          ) {
            throw commentError;
          }
          ({ data } = await this.octokit.pulls.createReview({
            ...publishedRequest,
            body: this.reviewBodyWithInlineFallbacks(fresh, headMarker),
            comments: [],
          }));
          return finish(String(data.id), null);
        }
      } else {
        if (
          (error as { status?: unknown }).status !== 422 ||
          fresh.length === 0
        ) {
          throw error;
        }
        ({ data } = await this.octokit.pulls.createReview({
          ...publishedRequest,
          body: this.reviewBodyWithInlineFallbacks(fresh, headMarker),
          comments: [],
        }));
        return finish(String(data.id), null);
      }
    }
    const comments = await this.octokit.paginate(
      this.octokit.pulls.listCommentsForReview,
      {
        ...this.ownerRepo,
        pull_number: prId,
        review_id: data.id,
        per_page: 100,
      },
    );
    return finish(String(data.id), this.alignReviewCommentIds(fresh, comments));
  }

  /**
   * The review threads on a pull request that belong to this workflow.
   *
   * Ownership needs BOTH tests, and it is the conjunction that matters. The finding
   * marker alone is text anybody can paste, so a human comment quoting one of ours
   * would be swept as if we had written it. `viewerDidAuthor` alone is true for
   * every thread this token ever opened, so two installations sharing a repository
   * would each retire the other's threads.
   *
   * The cost is that a thread opened before the marker existed is no longer ours to
   * touch, and stays open for good. That is the deliberate trade: this sweep now
   * writes an OUTDATED tick onto other people's conversations if it guesses wrong,
   * and guessing wrong is worse than leaving a handful of pre-marker threads behind.
   */
  private async ownReviewThreads(prId: number): Promise<OwnedReviewThread[]> {
    const threads: OwnedReviewThread[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: ReviewThreadsPage = await this.octokit.graphql(
        REVIEW_THREADS_QUERY,
        { ...this.ownerRepo, number: prId, cursor },
      );
      const connection: ReviewThreadsConnection | null | undefined =
        page?.repository?.pullRequest?.reviewThreads;
      for (const node of connection?.nodes ?? []) {
        const comments = (node?.comments?.nodes ?? []).filter(
          (comment): comment is NonNullable<typeof comment> => Boolean(comment),
        );
        const first = comments[0];
        if (!node?.id || !first?.id) continue;
        const digest = readReviewFindingDigest(first.body ?? "");
        if (digest === null || first.viewerDidAuthor !== true) continue;
        threads.push({
          id: node.id,
          isMinimized: first.isMinimized === true,
          commentId: first.id,
          commentReference:
            first.databaseId === undefined || first.databaseId === null
              ? null
              : String(first.databaseId),
          digest,
          hasHumanReply: comments.some(
            (comment) => comment.viewerDidAuthor !== true,
          ),
        });
      }
      if (connection?.pageInfo?.hasNextPage !== true) break;
      cursor = connection.pageInfo?.endCursor ?? null;
      if (cursor === null) break;
    }
    return threads;
  }

  /**
   * Marks a thread this round has moved past as outdated. It does not resolve it:
   * see `MINIMIZE_COMMENT_MUTATION` for why a repair cannot be claimed here.
   */
  private async retireReviewThread(thread: OwnedReviewThread): Promise<void> {
    try {
      await this.octokit.graphql(MINIMIZE_COMMENT_MUTATION, {
        subjectId: thread.commentId,
      });
    } catch (error) {
      // Collapsing an old comment is presentation, and the round's findings have
      // already been published by the time this runs. A repository that refuses it
      // must not cost the pull request its whole review.
      console.warn(
        `GitHub refused to hide outdated review comment ${thread.commentId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * The one summary comment for the pull request. Created once and rewritten from
   * then on, so a reader always has exactly one place that states where the review
   * currently stands.
   */
  private async upsertReviewSummary(
    prId: number,
    knownMarkers: string[],
    sections: string[],
  ): Promise<void> {
    // The bot marker is what trigger-events.ts reads to drop a comment event this
    // workflow produced. Without it, an installation running on a personal access
    // token rather than a GitHub App has no login to match against, and the first
    // round on every pull request fires a fresh review trigger off its own summary.
    const body = [...sections, AI_WORKFLOW_COMMENT_MARKER].join("\n\n");
    const comments = await this.octokit.paginate(
      this.octokit.issues.listComments,
      {
        ...this.ownerRepo,
        issue_number: prId,
        per_page: 100,
      },
    );
    const existing = comments.find((comment) =>
      knownMarkers.some((known) => comment.body?.includes(known)),
    );
    if (existing) {
      await this.octokit.issues.updateComment({
        ...this.ownerRepo,
        comment_id: existing.id,
        body,
      });
      return;
    }
    await this.octokit.issues.createComment({
      ...this.ownerRepo,
      issue_number: prId,
      body,
    });
  }

  /**
   * Findings this round reports that already have a thread.
   *
   * They get no inline comment of their own, so without this section they would be
   * absent from the one artifact a reader treats as the current state, and an
   * unfixed finding would read as fixed.
   */
  private carriedOverSummarySection(
    comments: PRReviewInlineComment[],
    carriedOver: Map<number, string | null>,
  ): string[] {
    const carried = comments.filter((_, index) => carriedOver.has(index));
    if (carried.length === 0) return [];
    return [
      "### Findings already open on this pull request",
      carried.map(reviewFallbackBullet).join("\n"),
    ];
  }

  private alignReviewCommentIds(
    authored: PRReviewPublication["comments"],
    published: Array<{
      id: number;
      path?: string | null;
      line?: number | null;
      start_line?: number | null;
    }>,
  ): Array<string | null> {
    const remaining = [...published];
    return authored.map((comment) => {
      const match = remaining.findIndex(
        (candidate) =>
          candidate.path === comment.path &&
          candidate.line === comment.endLine &&
          (comment.startLine === comment.endLine ||
            candidate.start_line === comment.startLine),
      );
      if (match < 0) return null;
      return String(remaining.splice(match, 1)[0]!.id);
    });
  }

  private reviewBodyWithInlineFallbacks(
    comments: PRReviewInlineComment[],
    headMarker: string,
  ): string {
    const findings = comments.map(reviewFallbackBullet);
    // Stays on the round's review rather than moving to the summary comment: these
    // findings are the ones GitHub refused to anchor at this head, so they belong
    // with the verdict for that head and the next round will try to place them
    // again.
    return roundReviewBody(headMarker, [
      `### Findings not placed inline\n${findings.join("\n")}`,
    ]);
  }

  async createGateStatus(
    name: string,
    headSha: string,
    ownershipKey?: string,
  ): Promise<GateStatusRef> {
    const existing = await this.octokit.paginate(
      this.octokit.checks.listForRef,
      {
        ...this.ownerRepo,
        ref: headSha,
        per_page: 100,
      },
    );
    const pending = existing.find(
      (check) =>
        check.name === name &&
        check.app?.id === this.config.auth.appId &&
        (ownershipKey === undefined || check.external_id === ownershipKey) &&
        (check.status === "queued" || check.status === "in_progress"),
    );
    if (pending) return { provider: "github", id: pending.id };
    const { data } = await this.octokit.checks.create({
      ...this.ownerRepo,
      name,
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      ...(ownershipKey ? { external_id: ownershipKey } : {}),
    });
    return { provider: "github", id: data.id };
  }

  async updateGateStatus(
    ref: GateStatusRef,
    update: GateStatusUpdate,
  ): Promise<void> {
    await this.updateGitHubGateStatus(ref, update);
  }

  async updateGateStatusDetails(
    ref: GateStatusRef,
    update: RichGateStatusUpdate,
  ): Promise<void> {
    await this.updateGitHubGateStatus(ref, update);
  }

  private async updateGitHubGateStatus(
    ref: GateStatusRef,
    update: RichGateStatusUpdate,
  ): Promise<void> {
    if (ref.provider !== "github") {
      throw new Error(`GitHubAdapter cannot update ${ref.provider} gate status`);
    }

    const baseParams = {
      ...this.ownerRepo,
      check_run_id: ref.id,
      status: update.status,
      ...(update.conclusion ? { conclusion: update.conclusion } : {}),
      ...(update.status === "completed"
        ? { completed_at: new Date().toISOString() }
        : {}),
    };

    const output =
      update.summary !== undefined || update.details !== undefined
        ? {
            title: update.summary?.slice(0, 200) ?? "",
            summary: update.summary ?? "",
            ...(update.details ? { text: update.details } : {}),
          }
        : undefined;

    const annotations = update.annotations ?? [];
    if (annotations.length === 0) {
      await this.octokit.checks.update({
        ...baseParams,
        ...(output ? { output } : {}),
      });
      return;
    }

    // GitHub's `output` is fully overwritten on each update. Carry title +
    // summary + text through every batch so subsequent calls don't erase the
    // details body set by the first.
    const outputBase = {
      title: output?.title ?? "",
      summary: output?.summary ?? "",
      ...(output?.text ? { text: output.text } : {}),
    };

    for (let i = 0; i < annotations.length; i += 50) {
      const batch = annotations.slice(i, i + 50);
      const isFirst = i === 0;
      await this.octokit.checks.update({
        ...this.ownerRepo,
        // Only the first batch flips status / conclusion / completed_at.
        ...(isFirst
          ? baseParams
          : { check_run_id: ref.id, status: update.status }),
        output: {
          ...outputBase,
          annotations: batch.map(mapAnnotation),
        },
      });
    }
  }

  /**
   * Every unresolved thread on the pull request, as ledger work items plus the
   * threads already waiting on a human.
   */
  async listReviewThreads(prId: number): Promise<ReviewThreadFeed> {
    // Taken before the first request: a comment that lands while the feed is being
    // read is then strictly newer than the snapshot, so `settleReviewThread` sees
    // it as human activity rather than missing it.
    const snapshotAt = new Date().toISOString();
    const inline = await this.ledgerInlineThreads(prId);
    const drafts = [...inline.drafts, ...(await this.ledgerGeneralThreads(prId))];
    const feed = buildReviewThreadFeed(drafts, snapshotAt);
    // Logged after the aliases are final so the metric names the alias the agent
    // sees. Only inline threads can reopen: a general comment is a thread of one
    // note, so a person answering it opens a new one instead.
    for (const thread of feed.threads) {
      if (!inline.reopened.has(thread.threadId)) continue;
      logger.info({
        event: "review_ledger.reopened",
        threadId: thread.threadId,
        alias: thread.alias,
      });
    }
    return feed;
  }

  /** Line-anchored review threads, the only kind GitHub can resolve. */
  private async ledgerInlineThreads(
    prId: number,
  ): Promise<{ drafts: LedgerDraftThread[]; reopened: Set<string> }> {
    const drafts: LedgerDraftThread[] = [];
    const reopened = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const page: LedgerReviewThreadsPage = await this.octokit.graphql(
        LEDGER_REVIEW_THREADS_QUERY,
        { ...this.ownerRepo, number: prId, cursor },
      );
      const connection = page?.repository?.pullRequest?.reviewThreads;
      for (const node of connection?.nodes ?? []) {
        // A resolved thread is settled business: re-raising it would have the
        // agent redo work a reviewer has already signed off.
        if (!node?.id || node.isResolved === true) continue;
        const comments = (node.comments?.nodes ?? []).filter(
          (comment): comment is LedgerReviewComment => Boolean(comment),
        );
        if (comments.length === 0) continue;
        // A minimized root comment is a thread the review sweep already retired as
        // outdated. Re-raising it would have the agent answer a finding this
        // workflow itself withdrew, and settling it would resolve it a second time.
        if (comments[0]?.isMinimized === true) continue;
        // `isOurs` is the provider's own answer to authorship; it stays out of
        // the notes the agent reads and only decides which markers are ours.
        const entries = comments.map((comment) => ({
          author: comment.author?.login ?? "unknown",
          body: comment.body ?? "",
          createdAt: comment.createdAt ?? "",
          isOurs: comment.viewerDidAuthor === true,
        }));
        const notes: ReviewThreadNote[] = entries.map((entry) => ({
          author: entry.author,
          body: entry.body,
          createdAt: entry.createdAt,
          // A marker alone proves nothing: a reviewer quoting our reply back at us
          // would otherwise park the thread on a human who is already waiting.
          isLedgerReply: entry.isOurs && readReviewLedgerMarker(entry.body) !== null,
        }));
        if (isReopenedLedgerThread(entries, (entry) => entry.isOurs)) {
          reopened.add(node.id);
        }
        drafts.push({
          threadId: node.id,
          source: ledgerInlineSource(comments[0]),
          resolvable: true,
          // The bot spoke last, so the ball is in the reviewer's court.
          awaitingHuman: notes[notes.length - 1]?.isLedgerReply === true,
          ...(node.path ? { filePath: node.path } : {}),
          ...(typeof node.line === "number" ? { line: node.line } : {}),
          notes,
        });
      }
      if (connection?.pageInfo?.hasNextPage !== true) break;
      cursor = connection.pageInfo?.endCursor ?? null;
      if (cursor === null) break;
    }
    return { drafts, reopened };
  }

  /**
   * Comments on the pull request itself: the general conversation plus the summary
   * box of every review that carried prose. Neither kind can be resolved, so they
   * enter the ledger as unresolvable threads that the bot can only answer.
   */
  private async ledgerGeneralThreads(prId: number): Promise<LedgerDraftThread[]> {
    const viewerLogin = await this.ledgerViewerLogin();
    const issueComments = await this.octokit.paginate(this.octokit.issues.listComments, {
      ...this.ownerRepo,
      issue_number: prId,
      per_page: 100,
    });
    // A review's summary box is neither an issue comment nor an inline comment: it
    // hangs off the review object, and without this a "request changes" carrying
    // only prose would never reach the ledger.
    const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
      ...this.ownerRepo,
      pull_number: prId,
      per_page: 100,
    });

    const entries: LedgerGeneralComment[] = [
      ...issueComments.map((comment) => ({
        threadId: `issue-comment:${comment.id}`,
        author: comment.user?.login ?? "unknown",
        isViewer: vcsLoginsMatch(comment.user?.login, viewerLogin),
        isProviderBot: comment.user?.type === "Bot",
        body: comment.body ?? "",
        createdAt: comment.created_at ?? "",
      })),
      ...reviews
        .filter((review) => (review.body ?? "").trim().length > 0)
        .map((review) => ({
          threadId: `review:${review.id}`,
          author: review.user?.login ?? "unknown",
          isViewer: vcsLoginsMatch(review.user?.login, viewerLogin),
          isProviderBot: review.user?.type === "Bot",
          body: review.body ?? "",
          createdAt: review.submitted_at ?? "",
        })),
    ];

    // A ledger reply is this workflow's answer to a thread, never a thread of its
    // own: left in the feed, the agent would read its own words back as fresh
    // review input and answer them. Only the plain marker parks a thread on a
    // human though; a stale reply is excluded from the feed as ours, but its
    // thread stays a work item because the person's newest words are unanswered.
    // Ours by authorship, not by marker: a reviewer quoting our reply is writing
    // review feedback, and dropping their comment would lose it entirely.
    const replies = entries.flatMap((entry) => {
      const target = entry.isViewer ? readReviewLedgerMarker(entry.body) : null;
      return target === null ? [] : [{ target, createdAt: entry.createdAt }];
    });

    return entries
      // Every note we write as ledger bookkeeping, the run failure note included:
      // keyed by run id, it matches no thread, so an id comparison would let last
      // run's apology back in as a work item for this one.
      .filter((entry) => !(entry.isViewer && isReviewLedgerNote(entry.body)))
      .map((entry): LedgerDraftThread => ({
        threadId: entry.threadId,
        source: entry.isViewer ? "bot" : entry.isProviderBot ? "third_party" : "human",
        resolvable: false,
        awaitingHuman: replies.some(
          (reply) =>
            reply.target === entry.threadId && reply.createdAt > entry.createdAt,
        ),
        notes: [
          {
            author: entry.author,
            body: entry.body,
            createdAt: entry.createdAt,
            isLedgerReply: false,
          },
        ],
      }));
  }

  /** Read once per adapter instance; see `LEDGER_VIEWER_QUERY`. */
  private async ledgerViewerLogin(): Promise<string | null> {
    if (this.cachedViewerLogin === undefined) {
      const result: { viewer?: { login?: string | null } | null } =
        await this.octokit.graphql(LEDGER_VIEWER_QUERY);
      this.cachedViewerLogin = result?.viewer?.login ?? null;
    }
    return this.cachedViewerLogin;
  }

  async settleReviewThread(
    input: SettleReviewThreadInput,
  ): Promise<SettleReviewThreadResult> {
    // A `PRRT_` id names a resolvable review thread. Every other ledger id names a
    // comment on the pull request itself, which GitHub cannot resolve at all.
    if (input.thread.threadId.startsWith("PRRT")) {
      return this.settleInlineReviewThread(input);
    }
    return this.settleGeneralThread(input);
  }

  private async settleInlineReviewThread(
    input: SettleReviewThreadInput,
  ): Promise<SettleReviewThreadResult> {
    const comments = await this.ledgerThreadComments(input.thread.threadId);
    const last = comments[comments.length - 1];
    // Checked first, against any marker variant, and only on a comment this token
    // wrote. Posting the reply and resolving are two calls, so a failure between
    // them is retried; the marker is what makes that retry post nothing a second
    // time. Reading only the plain marker here would re-post on every round of a
    // thread somebody keeps writing in, which is the loudest way to lose a
    // reviewer's trust; skipping the authorship check would let a reviewer who
    // quote-replied our answer silence the thread instead.
    if (
      last &&
      last.viewerDidAuthor === true &&
      readAnyReviewLedgerMarker(last.body ?? "") === input.thread.threadId
    ) {
      return { action: "skipped_existing_reply" };
    }

    // A reviewer who answered after the feed was read has seen something the
    // agent has not, and resolving on top of that would close a live objection.
    // Answering is still right, deciding it is not.
    const humanSpokeSinceSnapshot = comments.some(
      (comment) =>
        comment.viewerDidAuthor === false &&
        (comment.createdAt ?? "") > input.snapshotAt,
    );

    // GitHub's REST reply endpoint is addressed to a comment, and only to the one
    // that opened the thread: the thread node id it cannot take.
    const rootCommentId = comments[0]?.databaseId;
    if (rootCommentId === undefined || rootCommentId === null) {
      throw new Error(
        `GitHub review thread ${input.thread.threadId} has no comment to reply to`,
      );
    }
    // Both variants keep the bot marker (so this reply cannot trigger a run of its
    // own) and both leave the thread a work item if it ever comes back: stale
    // because the person's newest words are still unanswered, resolved because
    // only a person can reopen a resolved thread and that reopening is their move.
    const replyBody = humanSpokeSinceSnapshot
      ? markReviewLedgerReplyStale(input.body, input.thread.threadId)
      : input.resolve
        ? markReviewLedgerReplyResolved(input.body, input.thread.threadId)
        : input.body;
    await this.octokit.pulls.createReplyForReviewComment({
      ...this.ownerRepo,
      pull_number: input.prId,
      comment_id: rootCommentId,
      body: replyBody,
    });
    if (humanSpokeSinceSnapshot) return { action: "replied_stale" };
    if (!input.resolve) return { action: "replied" };
    await this.octokit.graphql(RESOLVE_REVIEW_THREAD_MUTATION, {
      threadId: input.thread.threadId,
    });
    return { action: "replied_and_resolved" };
  }

  /**
   * A comment on the pull request itself. GitHub cannot resolve one, so
   * `input.resolve` has nothing to act on here and the reply is the whole act.
   */
  private async settleGeneralThread(
    input: SettleReviewThreadInput,
  ): Promise<SettleReviewThreadResult> {
    const viewerLogin = await this.ledgerViewerLogin();
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      ...this.ownerRepo,
      issue_number: input.prId,
      per_page: 100,
    });
    const humanComments = comments.filter(
      (comment) =>
        !vcsLoginsMatch(comment.user?.login, viewerLogin) &&
        comment.user?.type !== "Bot",
    );
    // The LAST of our replies, any marker variant, and ours by authorship: a
    // multi-round thread carries several, measuring "has a human spoken since"
    // against the oldest one re-posts an answer on every round, and a reviewer
    // quoting our reply is not an answer of ours at all.
    const existingReply = [...comments]
      .reverse()
      .find(
        (comment) =>
          vcsLoginsMatch(comment.user?.login, viewerLogin) &&
          readAnyReviewLedgerMarker(comment.body ?? "") === input.thread.threadId,
      );
    // Already answered and nobody has spoken since: posting again would just repeat
    // this workflow back at the reader.
    if (
      existingReply &&
      !humanComments.some(
        (comment) => (comment.created_at ?? "") > (existingReply.created_at ?? ""),
      )
    ) {
      return { action: "skipped_existing_reply" };
    }
    const humanSpokeSinceSnapshot = humanComments.some(
      (comment) => (comment.created_at ?? "") > input.snapshotAt,
    );
    // The quote comes from the comment as it stands now, not from the feed the
    // run read: settlement is given thread identity only, and the live body is
    // the more honest source anyway.
    const quote = ledgerQuote(await this.ledgerGeneralSourceBody(input, comments));
    const body = humanSpokeSinceSnapshot
      ? markReviewLedgerReplyStale(input.body, input.thread.threadId)
      : input.body;
    await this.octokit.issues.createComment({
      ...this.ownerRepo,
      issue_number: input.prId,
      body: quote ? `${quote}\n\n${body}` : body,
    });
    return humanSpokeSinceSnapshot
      ? { action: "replied_stale" }
      : { action: "replied" };
  }

  /**
   * The body of the comment a general thread stands for. `issue-comment:<id>`
   * is in the list the caller already read; `review:<id>` is a review summary
   * box, which costs one extra call and only on that rarer id shape.
   */
  private async ledgerGeneralSourceBody(
    input: SettleReviewThreadInput,
    comments: ReadonlyArray<{ id?: number; body?: string | null }>,
  ): Promise<string> {
    const separator = input.thread.threadId.indexOf(":");
    if (separator < 0) return "";
    const kind = input.thread.threadId.slice(0, separator);
    const id = input.thread.threadId.slice(separator + 1);
    if (kind === "issue-comment") {
      return comments.find((comment) => String(comment.id) === id)?.body ?? "";
    }
    if (kind === "review") {
      const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
        ...this.ownerRepo,
        pull_number: input.prId,
        per_page: 100,
      });
      return reviews.find((review) => String(review.id) === id)?.body ?? "";
    }
    return "";
  }

  private async ledgerThreadComments(
    threadId: string,
  ): Promise<LedgerReviewComment[]> {
    const result: { node?: { comments?: { nodes?: Array<LedgerReviewComment | null> | null } | null } | null } =
      await this.octokit.graphql(LEDGER_REVIEW_THREAD_NODE_QUERY, { threadId });
    return (result?.node?.comments?.nodes ?? []).filter(
      (comment): comment is LedgerReviewComment => Boolean(comment),
    );
  }

  /**
   * Tells the pull request that a review run died before it could answer anything.
   * Once per run: the run is retried, and a pull request papered over with
   * identical failure notes is worse than one note nobody repeats.
   */
  async postRunFailureNote(input: PostRunFailureNoteInput): Promise<void> {
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      ...this.ownerRepo,
      issue_number: input.prId,
      per_page: 100,
    });
    if (
      comments.some((comment) =>
        hasReviewLedgerFailureMarker(comment.body ?? "", input.runId),
      )
    ) {
      return;
    }
    await this.octokit.issues.createComment({
      ...this.ownerRepo,
      issue_number: input.prId,
      body: `${input.body}\n\n${reviewLedgerFailureMarker(input.runId)}`,
    });
  }
}

function formatReviewState(state: string | null | undefined): string {
  switch (state) {
    case "CHANGES_REQUESTED":
      return "changes requested";
    case "APPROVED":
      return "approved";
    case "COMMENTED":
      return "comment";
    default:
      return (state ?? "review").toLowerCase();
  }
}

function mapFileStatus(status: string): PRFile["changeType"] {
  if (status === "added") return "added";
  if (status === "removed") return "removed";
  if (status === "renamed") return "renamed";
  return "modified";
}

function mapAnnotation(a: import("./types.js").CheckRunAnnotation) {
  return {
    path: a.path,
    start_line: a.startLine,
    end_line: a.endLine,
    ...(a.startColumn !== undefined ? { start_column: a.startColumn } : {}),
    ...(a.endColumn !== undefined ? { end_column: a.endColumn } : {}),
    annotation_level: a.annotationLevel,
    message: a.message,
    ...(a.title ? { title: a.title } : {}),
    ...(a.rawDetails ? { raw_details: a.rawDetails } : {}),
  };
}
