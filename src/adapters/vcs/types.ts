export interface PullRequest {
  id: number;
  url: string;
  branch: string;
}

export interface PRComment {
  author: string;
  body: string;
  liked: boolean;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

export interface CheckRunResult {
  name: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: string | null;
  logs?: string;
}

export interface VCSAdapter {
  createBranch(name: string, base: string): Promise<void>;
  createPR(branch: string, title: string, body: string): Promise<PullRequest>;
  push(
    branch: string,
    files: Array<{ path: string; content: string }>,
    options?: { mergeParentSha?: string; message?: string },
  ): Promise<void>;
  getPRComments(prId: number): Promise<PRComment[]>;
  getCheckRunResults(prId: number): Promise<CheckRunResult[]>;
  getPRConflictStatus(prId: number): Promise<boolean>;
  findPR(branch: string): Promise<PullRequest | null>;
  getBranchSha(branch: string): Promise<string>;

  // Review pipeline methods. Always defined on the interface; unsupported
  // providers (e.g. GitLab) signal at call-time by throwing NotSupportedError.
  getPullRequest(prNumber: number): Promise<ReviewPullRequest>;
  listPRFiles(prNumber: number): Promise<PRFile[]>;
  getPRDiff(prNumber: number): Promise<string>;
  getFileContentAtRef(path: string, ref: string): Promise<string | null>;
  listPRCommits(prNumber: number): Promise<PRCommitInfo[]>;
  listCheckRunsForRef(ref: string): Promise<CheckRunRef[]>;
  createCheckRun(input: CheckRunCreateInput): Promise<CheckRunRef>;
  updateCheckRun(checkRunId: number, input: CheckRunUpdateInput): Promise<CheckRunRef>;
  listCheckRunAnnotations(checkRunId: number): Promise<CheckRunAnnotation[]>;
  listExistingReviewComments(prNumber: number): Promise<ExistingReviewComment[]>;
  createReview(prNumber: number, comments: ReviewCommentInput[], body: string): Promise<void>;
}

export class NotSupportedError extends Error {
  constructor(method: string) {
    super(`${method} is not supported by this VCS adapter`);
    this.name = "NotSupportedError";
  }
}

export interface ReviewPullRequest {
  owner: string;
  repo: string;
  number: number;
  url: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  labels: string[];
  title: string;
  body: string | null;
  draft: boolean;
  user: string | null;
}

export interface PRFile {
  path: string;
  previous_path?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch?: string;
  changed_line_ranges: Array<{ start: number; end: number }>;
}

export interface PRCommitInfo {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
}

export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
  raw_details?: string;
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
  annotations?: CheckRunAnnotation[];
}

export interface CheckRunCreateInput {
  name: string;
  head_sha: string;
  external_id: string;
  status: "queued" | "in_progress" | "completed";
  started_at?: string;
  completed_at?: string;
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required";
  output?: CheckRunOutput;
}

export interface CheckRunUpdateInput extends Partial<Omit<CheckRunCreateInput, "name" | "head_sha" | "external_id">> {
  // name/head_sha/external_id are stable per Check Run
}

export interface CheckRunRef {
  id: number;
  external_id: string | null;
  name: string;
  head_sha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  output_text?: string | null;
}

export interface ReviewCommentInput {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: string;
}

export interface ExistingReviewComment {
  id: number;
  path: string | null;
  line: number | null;
  body: string;
  user: string | null;
}
