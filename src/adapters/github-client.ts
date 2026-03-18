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
    let refSha: string;
    try {
      const { data: ref } = await this.octokit.git.getRef({
        owner: repoOwner,
        repo: repoName,
        ref: `heads/${baseBranch}`,
      });
      refSha = ref.object.sha;
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error.status !== 409) throw err;

      try {
        const { data } = await this.octokit.repos.createOrUpdateFileContents({
          owner: repoOwner,
          repo: repoName,
          path: "README.md",
          message: "Initial commit",
          content: Buffer.from(`# ${repoName}\n`).toString("base64"),
        });
        refSha = data.commit.sha!;
      } catch (initErr) {
        throw new Error(
          `Failed to initialize empty repository ${repoOwner}/${repoName}: ${(initErr as Error).message}`,
        );
      }
    }

    try {
      await this.octokit.git.createRef({
        owner: repoOwner,
        repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: refSha,
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
    try {
      const { data } = await this.octokit.pulls.create({
        owner: repoOwner,
        repo: repoName,
        title,
        body,
        head,
        base,
      });

      return { number: data.number, url: data.html_url };
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error.status === 422) {
        const { data: prs } = await this.octokit.pulls.list({
          owner: repoOwner,
          repo: repoName,
          head: `${repoOwner}:${head}`,
          base,
          state: "open",
          per_page: 1,
        });
        if (prs.length > 0) {
          await this.octokit.pulls.update({
            owner: repoOwner,
            repo: repoName,
            pull_number: prs[0]!.number,
            title,
            body,
          });
          return { number: prs[0]!.number, url: prs[0]!.html_url };
        }
      }
      throw err;
    }
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
        fromApprovedReview:
          (c.reactions as Record<string, number> | undefined)?.["+1"] != null &&
          (c.reactions as Record<string, number>)["+1"] > 0,
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
