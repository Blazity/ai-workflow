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
  PullRequest,
  PRComment,
  CheckRunResult,
  PullRequestHead,
  RichGateStatusCapableVCS,
  RichGateStatusUpdate,
} from "./types.js";

export interface GitHubConfig {
  auth: GitHubAppAuth;
  owner: string;
  repo: string;
  baseBranch: string;
}

export class GitHubAdapter
  implements
    VCSAdapter,
    GateStatusCapableVCS,
    RichGateStatusCapableVCS,
    PRFilesCapableVCS
{
  private octokit: Octokit;

  constructor(private config: GitHubConfig) {
    this.octokit = buildOctokit(config.auth);
  }

  private get ownerRepo() {
    return { owner: this.config.owner, repo: this.config.repo };
  }

  async createBranch(name: string, base: string): Promise<void> {
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
    try {
      await this.octokit.git.createRef({
        ...this.ownerRepo,
        ref: `refs/heads/${name}`,
        sha: baseSha,
      });
    } catch (err: any) {
      if (err.status === 422) {
        // Branch already exists — force-reset it to the base SHA so the next
        // sandbox run starts with history rooted in the base branch.  Without
        // this, a stale branch from a previous failed run (e.g. one pushed from
        // a shallow clone) would retain orphan history, causing "no history in
        // common with main" errors on PR creation.
        await this.octokit.git.updateRef({
          ...this.ownerRepo,
          ref: `heads/${name}`,
          sha: baseSha,
          force: true,
        });
        return;
      }
      throw err;
    }
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
    return { headSha: data.head.sha, baseRef, state };
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

  async createGateStatus(name: string, headSha: string): Promise<GateStatusRef> {
    const { data } = await this.octokit.checks.create({
      ...this.ownerRepo,
      name,
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
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
