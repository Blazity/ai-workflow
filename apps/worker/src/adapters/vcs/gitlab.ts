import { Gitlab } from "@gitbeaker/rest";
import { FatalError } from "workflow";
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
} from "./types.js";

// Minimal shapes for gitbeaker responses we touch. Declared locally so we do
// not depend on gitbeaker's deep generic return types, which have changed
// across versions. Only the fields we actually read are listed.
interface GitLabMR {
  iid: number;
  web_url: string;
  source_branch: string;
}
interface GitLabNotePosition {
  new_path?: string;
  new_line?: number;
  old_path?: string;
  old_line?: number;
}
interface GitLabNote {
  system?: boolean;
  type?: string;
  author?: { username?: string };
  body?: string;
  position?: GitLabNotePosition;
}
interface GitLabDiscussion {
  notes?: GitLabNote[];
}
interface GitLabJob {
  id: number;
  name: string;
  status: string;
}
interface GitLabMRDiff {
  new_path?: string;
  old_path?: string;
  diff?: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  collapsed?: boolean;
  too_large?: boolean;
}

type GitLabCommitStatusState =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "canceled"
  | "skipped";

const COMMIT_STATUS_409_RETRY_DELAYS_MS = [500, 1_000, 2_000];

export interface GitLabConfig {
  token: string;
  projectId: string;
  baseBranch: string;
  /** Base URL for GitLab instance. Defaults to "https://gitlab.com". */
  host?: string;
}

export class GitLabAdapter implements VCSAdapter, GateStatusCapableVCS, PRFilesCapableVCS {
  private gl: InstanceType<typeof Gitlab>;
  private projectId: string;
  private baseBranch: string;

  constructor(private config: GitLabConfig) {
    this.gl = new Gitlab({
      token: config.token,
      ...(config.host ? { host: config.host } : {}),
    });
    this.projectId = config.projectId;
    this.baseBranch = config.baseBranch;
  }

  private get apiBaseUrl(): string {
    return `${(this.config.host ?? "https://gitlab.com").replace(/\/+$/, "")}/api/v4`;
  }

  private get encodedProjectId(): string {
    return encodeURIComponent(this.projectId);
  }

  async createBranch(name: string, base: string): Promise<void> {
    try {
      await this.gl.Branches.create(this.projectId, name, base);
    } catch (err: any) {
      const status = this.getStatusCode(err);

      if (status === 404) {
        await this.seedEmptyRepo(base);
        await this.gl.Branches.create(this.projectId, name, base);
        return;
      }

      // GitLab returns 400 for many validation errors. Only treat it as
      // "branch already exists" when the message says so; rethrow otherwise
      // so invalid-ref / invalid-name errors do not silently destroy branches.
      if (status === 400 && /already exists/i.test(String(err?.message ?? ""))) {
        await this.gl.Branches.remove(this.projectId, name);
        await this.gl.Branches.create(this.projectId, name, base);
        return;
      }

      throw err;
    }
  }

  private async seedEmptyRepo(branch: string): Promise<void> {
    try {
      await this.gl.RepositoryFiles.create(
        this.projectId,
        "README.md",
        branch,
        "Initial commit",
        "# Repository\n",
      );
    } catch (err: any) {
      throw new Error(
        `Failed to seed empty repository ${this.projectId}: ${err.message}`,
      );
    }
  }

  private getStatusCode(err: any): number | undefined {
    // gitbeaker error shapes vary across versions and transports:
    // - fetch-based: err.cause.response.status
    // - got-based:   err.response.statusCode / err.response.status
    // - normalized:  err.status / err.statusCode
    return (
      err?.cause?.response?.status ??
      err?.response?.status ??
      err?.response?.statusCode ??
      err?.status ??
      err?.statusCode
    );
  }

  private async gitLabRest<T>(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: Record<string, unknown>;
      retryOn409?: boolean;
    },
  ): Promise<T> {
    const { data } = await this.gitLabRestWithResponse<T>(path, options);
    return data;
  }

  private async gitLabRestWithResponse<T>(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: Record<string, unknown>;
      retryOn409?: boolean;
    },
  ): Promise<{ data: T; headers: Headers }> {
    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": this.config.token,
    };
    const init: RequestInit = {
      method: options.method,
      headers,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const retryDelays = options.retryOn409 ? COMMIT_STATUS_409_RETRY_DELAYS_MS : [];
    const maxAttempts = retryDelays.length + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await fetch(`${this.apiBaseUrl}${path}`, init);
      if (response.ok) {
        return {
          data:
            response.status === 204 ? (undefined as T) : ((await response.json()) as T),
          headers: response.headers,
        };
      }

      if (response.status === 409 && options.retryOn409 && attempt < maxAttempts) {
        await sleep(retryDelays[attempt - 1]);
        continue;
      }

      let details = "";
      try {
        details = await response.text();
      } catch {
        // Best-effort diagnostic body.
      }
      const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      throw new Error(
        `GitLab REST ${options.method} ${path} failed with ${status}${details ? `: ${details}` : ""}`,
      );
    }

    throw new Error(`GitLab REST ${options.method} ${path} failed`);
  }

  async createPR(
    branch: string,
    title: string,
    body: string,
  ): Promise<PullRequest> {
    try {
      const mr = await this.gl.MergeRequests.create(
        this.projectId,
        branch,
        this.baseBranch,
        title,
        { description: body },
      );
      return { id: mr.iid, url: String(mr.web_url), branch };
    } catch (err: any) {
      const status = this.getStatusCode(err);
      if (status === 409 || status === 404) {
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
    // GitLab's REST commits API creates linear commits only — it has no
    // equivalent to GitHub's two-parent createCommit for reconciling branch
    // histories. Conflict resolution on GitLab should go through an MR rebase
    // (MergeRequests.rebase) or an explicit merge, which is not part of this
    // adapter's push() contract. Fail loudly instead of silently producing a
    // single-parent commit that leaves the MR in a conflicted state.
    if (options?.mergeParentSha) {
      throw new FatalError(
        "GitLab adapter does not support merge-commit push (mergeParentSha). " +
          "Conflict resolution requires MR rebase and is not yet implemented.",
      );
    }

    // GitLab's REST commits API has no "upsert" action — each file must be
    // declared as either "create" or "update". Probe each path on the target
    // branch: 404 → create, otherwise update. Done in parallel to avoid a
    // linear-in-file-count latency hit.
    const actions = await Promise.all(
      files.map(async (f) => {
        const exists = await this.fileExistsOnBranch(f.path, branch);
        return {
          action: (exists ? "update" : "create") as "update" | "create",
          filePath: f.path,
          content: f.content,
        };
      }),
    );

    await this.gl.Commits.create(
      this.projectId,
      branch,
      options?.message ?? "feat: agent implementation",
      actions,
    );
  }

  private async fileExistsOnBranch(
    filePath: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await this.gl.RepositoryFiles.show(this.projectId, filePath, branch);
      return true;
    } catch (err: unknown) {
      if (this.getStatusCode(err) === 404) return false;
      throw err;
    }
  }

  async getBranchSha(branch: string): Promise<string> {
    const data = await this.gl.Branches.show(this.projectId, branch);
    return (data.commit as { id: string }).id;
  }

  async findPR(branch: string): Promise<PullRequest | null> {
    const mrs = (await this.gl.MergeRequests.all({
      projectId: this.projectId,
      sourceBranch: branch,
      state: "opened",
    })) as unknown as GitLabMR[];
    if (mrs.length === 0) return null;
    const mr = mrs[0];
    return { id: mr.iid, url: mr.web_url, branch: mr.source_branch };
  }

  async listPRFiles(prId: number): Promise<PRFile[]> {
    const diffs: GitLabMRDiff[] = [];
    let nextPath: string | null = this.mrDiffsPath(prId, "1");

    while (nextPath) {
      const response: { data: GitLabMRDiff[]; headers: Headers } =
        await this.gitLabRestWithResponse<GitLabMRDiff[]>(
          nextPath,
          { method: "GET" },
        );
      diffs.push(...response.data);
      nextPath = this.nextMRDiffsPath(prId, response.headers);
    }

    return diffs.map((change) => {
      const path = change.new_path ?? change.old_path ?? "";
      const patch =
        typeof change.diff === "string" && change.diff.length > 0
          ? change.diff
          : undefined;
      const stats = patch
        ? countDiffStats(patch)
        : { additions: 0, deletions: 0 };
      const file: PRFile = {
        path,
        additions: stats.additions,
        deletions: stats.deletions,
        changeType: this.mapMRChangeType(change),
      };
      if (patch !== undefined) file.patch = patch;
      return file;
    });
  }

  private mrDiffsPath(prId: number, page: string): string {
    return `/projects/${this.encodedProjectId}/merge_requests/${prId}/diffs?page=${encodeURIComponent(page)}&per_page=100`;
  }

  private nextMRDiffsPath(prId: number, headers: Headers): string | null {
    const nextPage = headers.get("x-next-page");
    if (nextPage) return this.mrDiffsPath(prId, nextPage);

    const nextUrl = this.nextLinkUrl(headers.get("link"));
    if (!nextUrl) return null;

    try {
      const url = new URL(nextUrl);
      return `${url.pathname.replace(/^\/api\/v4/, "")}${url.search}`;
    } catch {
      return nextUrl.startsWith("/") ? nextUrl : null;
    }
  }

  private nextLinkUrl(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    for (const part of linkHeader.split(",")) {
      const match = part.match(/<([^>]+)>\s*;\s*rel="next"/i);
      if (match) return match[1];
    }
    return null;
  }

  async createGateStatus(
    name: string,
    headSha: string,
  ): Promise<GateStatusRef> {
    await this.postCommitStatus(headSha, name, { state: "running" });
    return { provider: "gitlab", name, headSha };
  }

  async updateGateStatus(
    ref: GateStatusRef,
    update: GateStatusUpdate,
  ): Promise<void> {
    if (ref.provider !== "gitlab") {
      throw new Error(`GitLabAdapter cannot update ${ref.provider} gate status`);
    }

    await this.postCommitStatus(ref.headSha, ref.name, {
      state: this.mapCommitStatus(update),
      ...(update.summary !== undefined
        ? { description: update.summary.slice(0, 255) }
        : {}),
    });
  }

  private async postCommitStatus(
    headSha: string,
    name: string,
    params: { state: GitLabCommitStatusState; description?: string },
  ): Promise<void> {
    await this.gitLabRest<unknown>(
      `/projects/${this.encodedProjectId}/statuses/${headSha}`,
      {
        method: "POST",
        body: {
          state: params.state,
          name,
          ...(params.description !== undefined
            ? { description: params.description }
            : {}),
        },
        retryOn409: true,
      },
    );
  }

  private mapCommitStatus(update: GateStatusUpdate): GitLabCommitStatusState {
    if (update.status === "in_progress") return "running";

    if (update.status === "completed") {
      switch (update.conclusion) {
        case "success":
        case "neutral":
          return "success";
        case "failure":
        case "timed_out":
        case "action_required":
          return "failed";
        case "cancelled":
          return "canceled";
        case "skipped":
          return "skipped";
      }
    }

    return "pending";
  }

  private mapMRChangeType(change: GitLabMRDiff): PRFile["changeType"] {
    if (change.new_file) return "added";
    if (change.deleted_file) return "removed";
    if (change.renamed_file) return "renamed";
    return "modified";
  }

  async getPRComments(prId: number): Promise<PRComment[]> {
    const comments: PRComment[] = [];

    const discussions = (await this.gl.MergeRequestDiscussions.all(
      this.projectId,
      prId,
    )) as unknown as GitLabDiscussion[];
    for (const discussion of discussions) {
      for (const note of discussion.notes ?? []) {
        if (note.system) continue;
        if (note.type !== "DiffNote") continue;
        comments.push({
          author: note.author?.username ?? "unknown",
          body: String(note.body ?? ""),
          // GitLab notes have no direct "liked" signal comparable to GitHub
          // reactions. Intentionally hardcoded — see design spec.
          liked: false,
          // Comments on deleted lines only have old_path/old_line —
          // fall back so the anchor isn't lost.
          filePath: note.position?.new_path ?? note.position?.old_path,
          startLine: note.position?.new_line ?? note.position?.old_line,
          endLine: note.position?.new_line ?? note.position?.old_line,
        });
      }
    }

    const notes = (await this.gl.MergeRequestNotes.all(
      this.projectId,
      prId,
    )) as unknown as GitLabNote[];
    for (const note of notes) {
      if (note.system) continue;
      if (note.type === "DiffNote") continue;
      comments.push({
        author: note.author?.username ?? "unknown",
        body: String(note.body ?? ""),
        // See note above — liked is intentionally hardcoded for GitLab.
        liked: false,
      });
    }

    return comments;
  }

  async getCheckRunResults(prId: number): Promise<CheckRunResult[]> {
    const pipelines = await this.gl.MergeRequests.allPipelines(
      this.projectId,
      prId,
    );

    if (pipelines.length === 0) return [];

    const latestPipeline = pipelines[0];
    const jobs = (await this.gl.Jobs.all(this.projectId, {
      pipelineId: latestPipeline.id,
    })) as unknown as GitLabJob[];

    const results: CheckRunResult[] = [];
    for (const job of jobs) {
      const mapped = this.mapJobStatus(job.status);
      const entry: CheckRunResult = {
        name: job.name,
        status: mapped.status,
        conclusion: mapped.conclusion,
      };

      if (
        mapped.status === "completed" &&
        mapped.conclusion !== "success" &&
        mapped.conclusion !== null &&
        mapped.conclusion !== "skipped" &&
        mapped.conclusion !== "cancelled"
      ) {
        try {
          const log = await this.gl.Jobs.showLog(this.projectId, job.id);
          entry.logs = String(log);
        } catch {
          // Log fetching is best-effort
        }
      }

      results.push(entry);
    }

    return results;
  }

  private mapJobStatus(
    status: string,
  ): Pick<CheckRunResult, "status" | "conclusion"> {
    switch (status) {
      case "success":
        return { status: "completed", conclusion: "success" };
      case "failed":
        return { status: "completed", conclusion: "failure" };
      case "running":
        return { status: "in_progress", conclusion: null };
      case "pending":
      case "created":
        return { status: "queued", conclusion: null };
      case "canceled":
        return { status: "completed", conclusion: "cancelled" };
      case "skipped":
        return { status: "completed", conclusion: "skipped" };
      default:
        return { status: "queued", conclusion: null };
    }
  }

  async getPRConflictStatus(prId: number): Promise<boolean> {
    const mr = await this.gl.MergeRequests.show(this.projectId, prId);
    return (mr as { has_conflicts?: boolean }).has_conflicts === true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countDiffStats(diff: string): Pick<PRFile, "additions" | "deletions"> {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }

  return { additions, deletions };
}
