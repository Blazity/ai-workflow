import { FatalError } from "workflow";
import type { Octokit } from "@octokit/rest";
import { buildOctokit, type GitHubAppAuth } from "../../lib/github-auth.js";
import type {
  VCSAdapter,
  PullRequest,
  PRComment,
  CheckRunResult,
  ReviewPullRequest,
  PRFile,
  PRCommitInfo,
  CheckRunRef,
  CheckRunCreateInput,
  CheckRunUpdateInput,
  CheckRunAnnotation,
  ExistingReviewComment,
  ReviewCommentInput,
} from "./types.js";

export interface GitHubConfig {
  auth: GitHubAppAuth;
  owner: string;
  repo: string;
  baseBranch: string;
}

export class GitHubAdapter implements VCSAdapter {
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

  async getPRComments(prId: number): Promise<PRComment[]> {
    const { data: reviewComments } =
      await this.octokit.pulls.listReviewComments({
        ...this.ownerRepo,
        pull_number: prId,
      });
    const { data: issueComments } = await this.octokit.issues.listComments({
      ...this.ownerRepo,
      issue_number: prId,
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
    ];
    return comments;
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

  async findPR(branch: string): Promise<PullRequest | null> {
    const { data } = await this.octokit.pulls.list({
      ...this.ownerRepo,
      head: `${this.config.owner}:${branch}`,
      state: "open",
    });
    if (data.length === 0) return null;
    const pr = data[0];
    return { id: pr.number, url: pr.html_url, branch: pr.head.ref };
  }

  async getPullRequest(prNumber: number): Promise<ReviewPullRequest> {
    const { data } = await this.octokit.pulls.get({
      ...this.ownerRepo,
      pull_number: prNumber,
    });
    return {
      owner: this.config.owner,
      repo: this.config.repo,
      number: data.number,
      url: data.html_url,
      base: { ref: data.base.ref, sha: data.base.sha },
      head: { ref: data.head.ref, sha: data.head.sha },
      labels: data.labels.map((l) => l.name).filter((n): n is string => Boolean(n)),
      title: data.title,
      body: data.body ?? null,
      draft: data.draft ?? false,
      user: data.user?.login ?? null,
    };
  }

  async listPRFiles(prNumber: number): Promise<PRFile[]> {
    const files = await this.octokit.paginate(this.octokit.pulls.listFiles, {
      ...this.ownerRepo,
      pull_number: prNumber,
      per_page: 100,
    });
    return files.map((f) => ({
      path: f.filename,
      previous_path: f.previous_filename,
      status: f.status as PRFile["status"],
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
      changed_line_ranges: parseChangedLineRangesFromPatch(f.patch),
    }));
  }

  async getPRDiff(prNumber: number): Promise<string> {
    const { data } = await this.octokit.pulls.get({
      ...this.ownerRepo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });
    if (typeof data !== "string") {
      throw new Error(`Expected raw diff string from GitHub, got ${typeof data}`);
    }
    return data;
  }

  async getFileContentAtRef(path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        ...this.ownerRepo,
        path,
        ref,
      });
      if (Array.isArray(data) || data.type !== "file") return null;
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch (err: any) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async listPRCommits(prNumber: number): Promise<PRCommitInfo[]> {
    const commits = await this.octokit.paginate(this.octokit.pulls.listCommits, {
      ...this.ownerRepo,
      pull_number: prNumber,
      per_page: 100,
    });
    return commits.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.author?.login ?? c.commit.author?.name ?? null,
      date: c.commit.author?.date ?? null,
    }));
  }

  async listCheckRunsForRef(ref: string): Promise<CheckRunRef[]> {
    const checks = await this.octokit.paginate(this.octokit.checks.listForRef, {
      ...this.ownerRepo,
      ref,
      per_page: 100,
    });
    return checks.map((c) => ({
      id: c.id,
      external_id: c.external_id ?? null,
      name: c.name,
      head_sha: c.head_sha,
      status: c.status as CheckRunRef["status"],
      conclusion: c.conclusion ?? null,
      output_text: c.output?.text ?? null,
    }));
  }

  async createCheckRun(input: CheckRunCreateInput): Promise<CheckRunRef> {
    const { data } = await this.octokit.checks.create({
      ...this.ownerRepo,
      name: input.name,
      head_sha: input.head_sha,
      external_id: input.external_id,
      status: input.status,
      started_at: input.started_at,
      completed_at: input.completed_at,
      conclusion: input.conclusion,
      output: input.output,
    });
    return {
      id: data.id,
      external_id: data.external_id ?? null,
      name: data.name,
      head_sha: data.head_sha,
      status: data.status as CheckRunRef["status"],
      conclusion: data.conclusion ?? null,
      output_text: data.output?.text ?? null,
    };
  }

  async updateCheckRun(checkRunId: number, input: CheckRunUpdateInput): Promise<CheckRunRef> {
    const { data } = await this.octokit.checks.update({
      ...this.ownerRepo,
      check_run_id: checkRunId,
      status: input.status,
      started_at: input.started_at,
      completed_at: input.completed_at,
      conclusion: input.conclusion,
      output: input.output,
    });
    return {
      id: data.id,
      external_id: data.external_id ?? null,
      name: data.name,
      head_sha: data.head_sha,
      status: data.status as CheckRunRef["status"],
      conclusion: data.conclusion ?? null,
      output_text: data.output?.text ?? null,
    };
  }

  async listCheckRunAnnotations(checkRunId: number): Promise<CheckRunAnnotation[]> {
    const annotations = await this.octokit.paginate(this.octokit.checks.listAnnotations, {
      ...this.ownerRepo,
      check_run_id: checkRunId,
      per_page: 100,
    });
    return annotations.map((a) => ({
      path: a.path,
      start_line: a.start_line,
      end_line: a.end_line,
      start_column: a.start_column ?? undefined,
      end_column: a.end_column ?? undefined,
      annotation_level: a.annotation_level as CheckRunAnnotation["annotation_level"],
      message: a.message ?? "",
      title: a.title ?? undefined,
      raw_details: a.raw_details ?? undefined,
    }));
  }

  async listExistingReviewComments(prNumber: number): Promise<ExistingReviewComment[]> {
    const comments = await this.octokit.paginate(this.octokit.pulls.listReviewComments, {
      ...this.ownerRepo,
      pull_number: prNumber,
      per_page: 100,
    });
    return comments.map((c) => ({
      id: c.id,
      path: c.path ?? null,
      line: c.line ?? null,
      body: c.body,
      user: c.user?.login ?? null,
    }));
  }

  async createReview(prNumber: number, comments: ReviewCommentInput[], body: string): Promise<void> {
    await this.octokit.pulls.createReview({
      ...this.ownerRepo,
      pull_number: prNumber,
      event: "COMMENT",
      body,
      comments: comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side ?? "RIGHT",
        body: c.body,
      })),
    });
  }
}

export function buildCheckRunExternalId(configHash: string, checkId: string, headSha: string): string {
  return `ai-workflow:${configHash}:${checkId}:${headSha}`;
}

export function parseChangedLineRangesFromPatch(
  patch: string | undefined,
): Array<{ start: number; end: number }> {
  if (!patch) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

  const lines = patch.split("\n");
  let i = 0;

  while (i < lines.length) {
    const headerMatch = hunkHeaderRe.exec(lines[i]);
    if (!headerMatch) {
      i++;
      continue;
    }

    let newLineNum = parseInt(headerMatch[1], 10);
    i++;

    let rangeStart: number | null = null;
    let rangeEnd: number | null = null;

    while (i < lines.length && !hunkHeaderRe.test(lines[i])) {
      const line = lines[i];

      if (line.startsWith("+")) {
        // addition: part of the new file
        if (rangeStart === null) {
          rangeStart = newLineNum;
        }
        rangeEnd = newLineNum;
        newLineNum++;
      } else if (line.startsWith("-")) {
        // deletion: does not exist in new file — flush any open range
        if (rangeStart !== null && rangeEnd !== null) {
          ranges.push({ start: rangeStart, end: rangeEnd });
          rangeStart = null;
          rangeEnd = null;
        }
        // do NOT advance newLineNum for deletions
      } else {
        // context line: flush any open range
        if (rangeStart !== null && rangeEnd !== null) {
          ranges.push({ start: rangeStart, end: rangeEnd });
          rangeStart = null;
          rangeEnd = null;
        }
        newLineNum++;
      }

      i++;
    }

    // flush trailing range at end of hunk
    if (rangeStart !== null && rangeEnd !== null) {
      ranges.push({ start: rangeStart, end: rangeEnd });
    }
  }

  return ranges;
}
