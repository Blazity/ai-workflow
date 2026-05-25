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
}

export interface CheckRunAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  annotationLevel: "notice" | "warning" | "failure";
  message: string;
  title?: string;
  rawDetails?: string;
}

export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";

export interface CheckRunUpdate {
  status: "in_progress" | "completed";
  conclusion?: CheckRunConclusion;
  summary?: string;
  details?: string;
  annotations?: CheckRunAnnotation[];
}

/**
 * Capability interface — *not* extended onto VCSAdapter, because GitLab
 * has no equivalent. Callers check `hasCheckRunCapability(adapter)` before
 * invoking these methods. Adding methods to VCSAdapter directly would
 * force GitLab to throw at runtime; this surface keeps the failure to
 * detect-time, not invoke-time.
 */
export interface CheckRunCapableVCS {
  createCheckRun(name: string, headSha: string): Promise<number>;
  updateCheckRun(id: number, update: CheckRunUpdate): Promise<void>;
}

export function hasCheckRunCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & CheckRunCapableVCS {
  return (
    typeof (adapter as Partial<CheckRunCapableVCS>).createCheckRun === "function" &&
    typeof (adapter as Partial<CheckRunCapableVCS>).updateCheckRun === "function"
  );
}

export interface PRFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: "added" | "removed" | "modified" | "renamed";
  /** Unified diff hunk. Absent for binary or very large files. */
  patch?: string;
}

export interface PRFilesCapableVCS {
  listPRFiles(prId: number): Promise<PRFile[]>;
}

export function hasPRFilesCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & PRFilesCapableVCS {
  return typeof (adapter as Partial<PRFilesCapableVCS>).listPRFiles === "function";
}
