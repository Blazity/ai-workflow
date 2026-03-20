export interface PullRequest {
  id: number;
  url: string;
  branch: string;
}

export interface PRComment {
  author: string;
  body: string;
  liked: boolean;
}

export interface VCSAdapter {
  createBranch(name: string, base: string): Promise<void>;
  createPR(branch: string, title: string, body: string): Promise<PullRequest>;
  push(branch: string, files: Array<{ path: string; content: string }>): Promise<void>;
  getPRComments(prId: number): Promise<PRComment[]>;
  getPRConflictStatus(prId: number): Promise<boolean>;
  findPR(branch: string): Promise<PullRequest | null>;
}
