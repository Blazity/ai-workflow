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
    const [reviewComments, issueComments, reviews] = await Promise.all([
      this.octokit.pulls.listReviewComments({
        owner: repoOwner,
        repo: repoName,
        pull_number: prNumber,
      }),
      this.octokit.issues.listComments({
        owner: repoOwner,
        repo: repoName,
        issue_number: prNumber,
      }),
      this.octokit.pulls.listReviews({
        owner: repoOwner,
        repo: repoName,
        pull_number: prNumber,
      }),
    ]);

    // Inline code review comments (attached to specific lines)
    const inline: PullRequestComment[] = reviewComments.data.map(
      (c): PullRequestComment => ({
        author: c.user?.login ?? "unknown",
        body: c.body,
        path: c.path ?? null,
        line: c.line ?? null,
        fromApprovedReview:
          (c.reactions as unknown as Record<string, number> | undefined)?.["+1"] != null &&
          (c.reactions as unknown as Record<string, number>)["+1"] > 0,
      }),
    );

    // General PR conversation comments
    const general: PullRequestComment[] = issueComments.data
      .filter((c) => c.body)
      .map(
        (c): PullRequestComment => ({
          author: c.user?.login ?? "unknown",
          body: c.body!,
          path: null,
          line: null,
          fromApprovedReview: false,
        }),
      );

    // Review body text (from "Request changes" / "Approve" submissions)
    const reviewBodies: PullRequestComment[] = reviews.data
      .filter((r) => r.body)
      .map(
        (r): PullRequestComment => ({
          author: r.user?.login ?? "unknown",
          body: r.body!,
          path: null,
          line: null,
          fromApprovedReview: r.state === "APPROVED",
        }),
      );

    return [...inline, ...general, ...reviewBodies];
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

  async pushChanges(
    repoOwner: string,
    repoName: string,
    branchName: string,
    message: string,
    files: Array<{ path: string; content: string | null }>,
  ): Promise<string> {
    // Get the current branch tip
    const { data: ref } = await this.octokit.git.getRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${branchName}`,
    });
    const baseSha = ref.object.sha;

    const { data: baseCommit } = await this.octokit.git.getCommit({
      owner: repoOwner,
      repo: repoName,
      commit_sha: baseSha,
    });

    // Build tree entries — create blobs for added/modified, null sha for deleted
    const treeItems: Array<{
      path: string;
      mode: "100644";
      type: "blob";
      sha: string | null;
    }> = [];

    for (const file of files) {
      if (file.content === null) {
        // Deleted file — sha null removes it from the tree
        treeItems.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      } else {
        const { data: blob } = await this.octokit.git.createBlob({
          owner: repoOwner,
          repo: repoName,
          content: file.content,
          encoding: "base64",
        });
        treeItems.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
      }
    }

    const { data: tree } = await this.octokit.git.createTree({
      owner: repoOwner,
      repo: repoName,
      base_tree: baseCommit.tree.sha,
      tree: treeItems,
    });

    const { data: commit } = await this.octokit.git.createCommit({
      owner: repoOwner,
      repo: repoName,
      message,
      tree: tree.sha,
      parents: [baseSha],
    });

    await this.octokit.git.updateRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${branchName}`,
      sha: commit.sha,
    });

    return commit.sha;
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
