import { FatalError } from "workflow";
import type { Octokit } from "@octokit/rest";
import { buildOctokit, type GitHubAppAuth } from "../../lib/github-auth.js";
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
} from "./types.js";
import { reviewFallbackBullet, reviewFindingDigest } from "./types.js";

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

/** The marker family is this adapter's; the digest formula inside it is shared. */
function reviewFindingMarker(comment: PRReviewInlineComment): string {
  return `<!-- ai-workflow-review-finding:${reviewFindingDigest(comment)} -->`;
}

function readReviewFindingDigest(body: string): string | null {
  return /<!-- ai-workflow-review-finding:([0-9a-f]+) -->/.exec(body)?.[1] ?? null;
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

const REVIEW_THREADS_QUERY = `
  query reviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes { id databaseId body viewerDidAuthor }
            }
          }
        }
      }
    }
  }
`;

/**
 * GitHub's only resolve primitive, and it is GraphQL-only: REST exposes review
 * comments but not the thread they hang from, and "resolved" is a property of the
 * thread. https://docs.github.com/graphql, Mutation.resolveReviewThread.
 */
const RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation resolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { isResolved }
    }
  }
`;

/**
 * The collapse half. Resolving already folds a thread away in the Files view;
 * minimizing is what marks the comment itself outdated and hides its text in the
 * conversation. https://docs.github.com/graphql, Mutation.minimizeComment.
 */
const MINIMIZE_COMMENT_MUTATION = `
  mutation minimizeComment($subjectId: ID!) {
    minimizeComment(input: { subjectId: $subjectId, classifier: OUTDATED }) {
      minimizedComment { isMinimized }
    }
  }
`;

interface ReviewThreadsConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: Array<{
    id?: string;
    isResolved?: boolean;
    comments?: {
      nodes?: Array<{
        id?: string;
        databaseId?: number | null;
        body?: string | null;
        viewerDidAuthor?: boolean;
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
  isResolved: boolean;
  /** Node id of the thread's first comment, the subject `minimizeComment` takes. */
  commentId: string;
  commentReference: string | null;
  digest: string | null;
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
    const digests = publication.comments.map(reviewFindingDigest);
    // Reported inline AND reported into the summary. A finding the cap pushed out
    // of the inline set is still standing, so its thread must not read as resolved
    // while the summary lists it: the two would say opposite things about one
    // defect, which is the misleading state this whole change is about.
    const reported = new Set([
      ...digests,
      ...(publication.deferredFindingDigests ?? []),
    ]);
    const openByDigest = new Map<string, OwnedReviewThread>();
    for (const thread of threads) {
      if (thread.digest !== null) openByDigest.set(thread.digest, thread);
    }

    // A thread this round no longer reports is settled: resolve it and hide it.
    // Threads with no digest are the ones opened before that marker existed, and
    // they are settled by the same rule: if their finding still held, this round
    // reported it and has just opened a digest-marked thread for it.
    for (const thread of threads) {
      if (thread.digest !== null && reported.has(thread.digest)) continue;
      if (thread.isResolved) continue;
      await this.retireReviewThread(thread);
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
      comments: fresh.map((comment) => ({
        path: comment.path,
        // The marker travels with the comment because the thread it opens is what
        // a later round has to recognise. GitHub returns comment bodies verbatim,
        // so this is the anchor that survives a push.
        body: `${comment.body}\n\n${reviewFindingMarker(comment)}`,
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
   * Ownership is the finding marker, and for threads opened before that marker
   * existed, `viewerDidAuthor`. Without the second test those threads would be
   * invisible to the resolve sweep and stay open forever on every pull request
   * that was reviewed before this change shipped.
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
        const first = node?.comments?.nodes?.[0];
        if (!node?.id || !first?.id) continue;
        const digest = readReviewFindingDigest(first.body ?? "");
        if (digest === null && first.viewerDidAuthor !== true) continue;
        threads.push({
          id: node.id,
          isResolved: node.isResolved === true,
          commentId: first.id,
          commentReference:
            first.databaseId === undefined || first.databaseId === null
              ? null
              : String(first.databaseId),
          digest,
        });
      }
      if (connection?.pageInfo?.hasNextPage !== true) break;
      cursor = connection.pageInfo?.endCursor ?? null;
      if (cursor === null) break;
    }
    return threads;
  }

  private async retireReviewThread(thread: OwnedReviewThread): Promise<void> {
    await this.octokit.graphql(RESOLVE_REVIEW_THREAD_MUTATION, {
      threadId: thread.id,
    });
    try {
      await this.octokit.graphql(MINIMIZE_COMMENT_MUTATION, {
        subjectId: thread.commentId,
      });
    } catch (error) {
      // Resolving is the half that carries the meaning and it has already
      // happened; hiding the text is presentation. A repository that refuses it
      // must not cost the pull request its whole review.
      console.warn(
        `GitHub refused to hide resolved review comment ${thread.commentId}: ` +
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
    const body = sections.join("\n\n");
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
