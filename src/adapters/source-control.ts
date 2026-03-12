export interface SourceControlAdapter {
  createBranch(
    repoOwner: string,
    repoName: string,
    branchName: string,
    baseBranch: string,
  ): Promise<void>;

  createPullRequest(
    repoOwner: string,
    repoName: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<PullRequest>;

  getPullRequestComments(
    repoOwner: string,
    repoName: string,
    prNumber: number,
  ): Promise<PullRequestComment[]>;

  /** Merges baseBranch into branchName (e.g., merge main into feature branch for conflict resolution) */
  mergeBranch(
    repoOwner: string,
    repoName: string,
    branchName: string,
    baseBranch: string,
  ): Promise<void>;
}

export interface PullRequest {
  number: number;
  url: string;
}

export interface PullRequestComment {
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  fromApprovedReview: boolean;
}
