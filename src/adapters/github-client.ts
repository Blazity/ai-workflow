import { Octokit } from "@octokit/rest";
import type {
  PullRequest,
  PullRequestComment,
  VCSAdapter,
} from "./source-control.js";

export class GitHubClient implements VCSAdapter {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async createBranch(
    repoOwner: string,
    repoName: string,
    branchName: string,
    baseBranch: string,
  ): Promise<void> {
    const { data: ref } = await this.octokit.git.getRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${baseBranch}`,
    });

    try {
      await this.octokit.git.createRef({
        owner: repoOwner,
        repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha,
      });
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error.status === 422) return;
      throw err;
    }
  }

  async createPR(
    repoOwner: string,
    repoName: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.create({
      owner: repoOwner,
      repo: repoName,
      title,
      body,
      head,
      base,
    });

    return { number: data.number, url: data.html_url };
  }

  async getPRComments(
    repoOwner: string,
    repoName: string,
    prNumber: number,
  ): Promise<PullRequestComment[]> {
    const { data } = await this.octokit.pulls.listReviewComments({
      owner: repoOwner,
      repo: repoName,
      pull_number: prNumber,
    });

    return data.map(
      (c): PullRequestComment => ({
        author: c.user?.login ?? "unknown",
        body: c.body,
        path: c.path ?? null,
        line: c.line ?? null,
        fromApprovedReview: false,
      }),
    );
  }

  async getPRConflictStatus(
    repoOwner: string,
    repoName: string,
    prNumber: number,
  ): Promise<boolean> {
    const { data } = await this.octokit.pulls.get({
      owner: repoOwner,
      repo: repoName,
      pull_number: prNumber,
    });

    return data.mergeable === false;
  }

  async getFileContent(
    repoOwner: string,
    repoName: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: repoOwner,
        repo: repoName,
        path,
        ref,
      });
      if ("content" in data && data.type === "file") {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }
      return null;
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error.status === 404) return null;
      throw err;
    }
  }
}
