export interface VCSAdapter {
  createBranch(
    repoOwner: string,
    repoName: string,
    branchName: string,
    baseBranch: string,
  ): Promise<void>;

  createPR(
    repoOwner: string,
    repoName: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<PullRequest>;

  getPRComments(
    repoOwner: string,
    repoName: string,
    prNumber: number,
  ): Promise<PullRequestComment[]>;

  getPRConflictStatus(
    repoOwner: string,
    repoName: string,
    prNumber: number,
  ): Promise<boolean>;
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
