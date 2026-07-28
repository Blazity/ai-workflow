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

  async publishPRReview(
    prId: number,
    publication: PRReviewPublication,
  ): Promise<PRReviewPublicationResult> {
    const marker = `<!-- ai-workflow-review:${publication.idempotencyKey} -->`;
    const existing = await this.octokit.paginate(this.octokit.pulls.listReviews, {
      ...this.ownerRepo,
      pull_number: prId,
      per_page: 100,
    });
    const prior = existing.find((review) => review.body?.includes(marker));
    if (prior) {
      const comments = await this.octokit.paginate(
        this.octokit.pulls.listCommentsForReview,
        {
          ...this.ownerRepo,
          pull_number: prId,
          review_id: prior.id,
          per_page: 100,
        },
      );
      return {
        id: String(prior.id),
        commentIds: this.alignReviewCommentIds(publication.comments, comments),
      };
    }
    const request: Parameters<Octokit["pulls"]["createReview"]>[0] = {
      ...this.ownerRepo,
      pull_number: prId,
      commit_id: publication.headSha,
      event:
        publication.decision === "approve"
          ? ("APPROVE" as const)
          : ("REQUEST_CHANGES" as const),
      body: `${publication.summary}\n\n${marker}`,
      comments: publication.comments.map((comment) => ({
        path: comment.path,
        body: comment.body,
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
            publication.comments.length === 0
          ) {
            throw commentError;
          }
          ({ data } = await this.octokit.pulls.createReview({
            ...publishedRequest,
            body: this.reviewBodyWithInlineFallbacks(publication, marker),
            comments: [],
          }));
          return {
            id: String(data.id),
            commentIds: publication.comments.map(() => null),
          };
        }
      } else {
        if (
          (error as { status?: unknown }).status !== 422 ||
          publication.comments.length === 0
        ) {
          throw error;
        }
        ({ data } = await this.octokit.pulls.createReview({
          ...publishedRequest,
          body: this.reviewBodyWithInlineFallbacks(publication, marker),
          comments: [],
        }));
        return {
          id: String(data.id),
          commentIds: publication.comments.map(() => null),
        };
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
    return {
      id: String(data.id),
      commentIds: this.alignReviewCommentIds(publication.comments, comments),
    };
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
    publication: PRReviewPublication,
    marker: string,
  ): string {
    const findings = publication.comments.map((comment) => {
      const range =
        comment.startLine === comment.endLine
          ? String(comment.startLine)
          : `${comment.startLine}-${comment.endLine}`;
      return `- \`${comment.path}:${range}\` — ${comment.body}`;
    });
    return `${publication.summary}\n\n### Findings not placed inline\n${findings.join("\n")}\n\n${marker}`;
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
