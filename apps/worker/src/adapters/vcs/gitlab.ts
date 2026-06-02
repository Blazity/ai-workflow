import { Gitlab } from "@gitbeaker/rest";
import { FatalError } from "workflow";
import type {
  VCSAdapter,
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

export interface GitLabConfig {
  token: string;
  projectId: string;
  baseBranch: string;
  /** Base URL for GitLab instance. Defaults to "https://gitlab.com". */
  host?: string;
}

export class GitLabAdapter implements VCSAdapter {
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
