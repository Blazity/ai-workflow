import { createHash } from "node:crypto";
import { Gitlab } from "@gitbeaker/rest";
import { FatalError } from "workflow";
import type {
  VCSAdapter,
  GateStatusUpdate,
  GateStatusCapableVCS,
  GateStatusRef,
  PRFile,
  PRFilesCapableVCS,
  PRReviewCapableVCS,
  PRReviewInlineComment,
  PRReviewPublication,
  PRReviewPublicationResult,
  PullRequest,
  PullRequestHead,
  PRComment,
  CheckRunResult,
  ManualDispatchPrCapableVCS,
  ManualDispatchPullRequestSnapshot,
  ReviewThread,
  ReviewThreadFeed,
  ReviewThreadSource,
  SettleReviewThreadInput,
  SettleReviewThreadResult,
  PostRunFailureNoteInput,
} from "./types.js";
import {
  readReviewFindingDigest,
  reviewFallbackBullet,
  REVIEW_LEDGER_MAX_WORK_ITEMS,
} from "./types.js";
import { clampBothEnds } from "../../workflow-definition/failure-message.js";
import {
  AI_WORKFLOW_COMMENT_MARKER,
  hasReviewLedgerFailureMarker,
  readReviewLedgerMarker,
  reviewLedgerFailureMarker,
} from "../../lib/vcs-bot-identity.js";

/**
 * Posted into a discussion just before it is resolved. GitLab's only way to collapse
 * a thread is to mark it resolved, and that word on its own would tell a reader the
 * defect was fixed. This note is what makes the strip mean what actually happened.
 *
 * Carries the bot marker so trigger-events.ts drops the note event instead of
 * treating it as a human comment and starting another round.
 */
const SUPERSEDED_DISCUSSION_NOTE = [
  "This thread was opened by an earlier review round and the current round no " +
    "longer reports this finding under the same wording. Resolving it here means " +
    "superseded, not verified as fixed: re-open it if the issue still stands.",
  AI_WORKFLOW_COMMENT_MARKER,
].join("\n\n");

// Minimal shapes for gitbeaker responses we touch. Declared locally so we do
// not depend on gitbeaker's deep generic return types, which have changed
// across versions. Only the fields we actually read are listed.
interface GitLabMR {
  iid: number;
  web_url: string;
  source_branch: string;
  sha?: string;
  diff_refs?: { base_sha?: string; start_sha?: string; head_sha?: string };
}
interface GitLabMRHead {
  diff_refs?: { head_sha?: string };
  sha?: string;
  target_branch?: string;
  source_branch?: string;
  state?: string;
  web_url?: string;
  title?: string;
  author?: { username?: string };
  draft?: boolean;
  work_in_progress?: boolean;
  merge_commit_sha?: string;
  merged_at?: string;
  head_pipeline?: { id?: number; status?: string } | null;
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
  author?: { username?: string; bot?: boolean };
  body?: string;
  created_at?: string;
  resolved?: boolean;
  position?: GitLabNotePosition;
}
interface GitLabDiscussion {
  id?: string;
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

interface OwnedReviewDiscussion {
  discussion: { id?: string };
  digest: string;
  resolved: boolean;
  /**
   * Somebody other than this workflow has commented in the thread. Such a
   * discussion is never touched: a reader's question resolved out from under
   * them is a worse outcome than a stale discussion left open.
   */
  hasHumanReply: boolean;
  /**
   * A superseding note was already posted to this discussion. Posting the note
   * and resolving are two calls, so a failure between them is retried without
   * posting the note a second time.
   */
  hasSupersededNote: boolean;
}

export class GitLabAdapter implements
  VCSAdapter,
  GateStatusCapableVCS,
  PRFilesCapableVCS,
  PRReviewCapableVCS,
  ManualDispatchPrCapableVCS
{
  private gl: InstanceType<typeof Gitlab>;
  private projectId: string;
  private baseBranch: string;
  /** `undefined` until looked up; `null` when GitLab returned no username. */
  private cachedUsername: string | null | undefined;

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

  async createBranchIfMissing(
    name: string,
    base: string,
  ): Promise<"created" | "existing"> {
    try {
      await this.gl.Branches.create(this.projectId, name, base);
      return "created";
    } catch (err: any) {
      const status = this.getStatusCode(err);

      if (status === 404) {
        await this.seedEmptyRepo(base);
        await this.gl.Branches.create(this.projectId, name, base);
        return "created";
      }

      if (status === 400 && /already exists/i.test(String(err?.message ?? ""))) {
        return "existing";
      }

      throw err;
    }
  }

  async resetOwnedBranch(name: string, base: string): Promise<void> {
    // Non-atomicity hazard: GitLab has no force-update ref API, so a reset is a
    // delete followed by a create. A failure between the two calls leaves the
    // branch deleted, and GitLab auto-closes any MR whose source branch
    // disappears. Recovery is not local to this call: the surviving
    // workflow-owned-branch ledger row still names the branch, so the next reset
    // attempt re-runs this path and the create re-establishes it (the MR is
    // reopened/recreated downstream). This is only ever invoked for a branch the
    // database proves the workflow owns.
    await this.gl.Branches.remove(this.projectId, name);
    await this.gl.Branches.create(this.projectId, name, base);
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

  private throwWithProviderRetrySemantics(err: any): never {
    const status = this.getStatusCode(err);
    const retryableClientStatuses = new Set([408, 425, 429]);
    if (
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      !retryableClientStatuses.has(status)
    ) {
      throw new FatalError(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }

  private async gitLabRest<T>(
    path: string,
    options: {
      method: "GET" | "POST" | "PUT";
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
      method: "GET" | "POST" | "PUT";
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
      const error = new Error(
        `GitLab REST ${options.method} ${path} failed with ${status}${details ? `: ${details}` : ""}`,
      );
      Object.assign(error, { status: response.status });
      throw error;
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
      this.throwWithProviderRetrySemantics(err);
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
    try {
      const data = await this.gl.Branches.show(this.projectId, branch);
      return (data.commit as { id: string }).id;
    } catch (err) {
      this.throwWithProviderRetrySemantics(err);
    }
  }

  async getBranchShaIfExists(branch: string): Promise<string | null> {
    try {
      const data = await this.gl.Branches.show(this.projectId, branch);
      return (data.commit as { id: string }).id;
    } catch (err: any) {
      if (this.getStatusCode(err) === 404) return null;
      this.throwWithProviderRetrySemantics(err);
    }
  }

  async getPRHead(prId: number): Promise<PullRequestHead> {
    const mr = (await this.gl.MergeRequests.show(
      this.projectId,
      prId,
    )) as unknown as GitLabMRHead;
    const headSha = mr.diff_refs?.head_sha ?? mr.sha ?? "";
    if (!headSha) throw new Error(`GitLab MR !${prId} is missing its authoritative head SHA`);
    const baseRef = mr.target_branch?.trim();
    if (!baseRef) throw new Error(`GitLab MR !${prId} is missing its target branch`);
    const state =
      mr.state === "opened"
        ? "open"
        : mr.state === "closed" || mr.state === "merged"
          ? mr.state
          : null;
    if (!state) {
      throw new Error(`GitLab MR !${prId} has unsupported lifecycle state ${String(mr.state)}`);
    }
    const headPipelineId = mr.head_pipeline?.id;
    const headPipelineStatus = mr.head_pipeline?.status;
    const headPipelineFailedChecks =
      typeof headPipelineId === "number" && headPipelineStatus === "failed"
        ? ((await this.gl.Jobs.all(this.projectId, {
            pipelineId: headPipelineId,
          })) as unknown as GitLabJob[])
            .filter((job) => job.status === "failed")
            .map((job) => ({ id: job.id, name: job.name }))
        : undefined;
    return {
      headSha,
      ...(mr.source_branch ? { headRef: mr.source_branch } : {}),
      baseRef,
      state,
      ...(typeof headPipelineId === "number" ? { headPipelineId } : {}),
      ...(typeof headPipelineStatus === "string" ? { headPipelineStatus } : {}),
      ...(headPipelineFailedChecks ? { headPipelineFailedChecks } : {}),
    };
  }

  async getManualDispatchPullRequest(
    prId: number,
  ): Promise<ManualDispatchPullRequestSnapshot> {
    const mr = (await this.gl.MergeRequests.show(
      this.projectId,
      prId,
    )) as unknown as GitLabMRHead;
    const current = await this.getPRHead(prId);
    const [comments, pipeline] = await Promise.all([
      this.getPRComments(prId),
      typeof current.headPipelineId === "number"
        ? this.gl.Pipelines.show(this.projectId, current.headPipelineId)
        : Promise.resolve(null),
    ]);
    return {
      prNumber: prId,
      prUrl:
        mr.web_url ??
        `${(this.config.host ?? "https://gitlab.com").replace(/\/+$/, "")}/${this.projectId}/-/merge_requests/${prId}`,
      headRef: mr.source_branch ?? "",
      headSha: current.headSha,
      baseRef: current.baseRef,
      title: mr.title ?? "",
      author: mr.author?.username ?? "unknown",
      isDraft: mr.draft === true || mr.work_in_progress === true,
      state: current.state,
      ...(current.state === "merged" && mr.merge_commit_sha
        ? { mergeSha: mr.merge_commit_sha }
        : {}),
      ...(current.state === "merged" && mr.merged_at
        ? { mergedAt: mr.merged_at }
        : {}),
      ...(typeof current.headPipelineId === "number"
        ? { pipelineId: current.headPipelineId }
        : {}),
      ...(pipeline && typeof (pipeline as { source?: unknown }).source === "string"
        ? { pipelineSource: (pipeline as { source: string }).source }
        : {}),
      failedChecks: (current.headPipelineFailedChecks ?? []).map((check) => ({
        name: check.name,
        conclusion: "failed",
      })),
      reviews: comments
        .filter((comment) => comment.body.trim().length > 0)
        .map((comment) => ({
          state: "commented" as const,
          author: comment.author,
          body: comment.body,
        })),
    };
  }

  async findPR(branch: string): Promise<PullRequest | null> {
    try {
      const mrs = (await this.gl.MergeRequests.all({
        projectId: this.projectId,
        sourceBranch: branch,
        targetBranch: this.baseBranch,
        state: "opened",
      })) as unknown as GitLabMR[];
      if (mrs.length === 0) return null;
      const mr = mrs[0];
      return { id: mr.iid, url: mr.web_url, branch: mr.source_branch };
    } catch (err) {
      this.throwWithProviderRetrySemantics(err);
    }
  }

  async getPRHeadSha(prId: number): Promise<string> {
    try {
      const mr = (await this.gl.MergeRequests.show(
        this.projectId,
        prId,
      )) as unknown as GitLabMR;
      if (!mr.sha) {
        throw new FatalError(`GitLab merge request !${prId} did not include a head SHA`);
      }
      return mr.sha;
    } catch (err) {
      if (err instanceof FatalError) throw err;
      this.throwWithProviderRetrySemantics(err);
    }
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

  /**
   * Three artifacts with three different lifetimes, so a merge request does not
   * collect a round's worth of everything on every push:
   *
   *  - one DISCUSSION per finding, opened once and carried across rounds, resolved
   *    as soon as the round stops reporting it (GitLab collapses a resolved thread,
   *    which is the same act here, since there is no separate hide call);
   *  - one inline discussion per finding that is NEW to this round;
   *  - one SUMMARY note for the whole merge request, edited in place.
   */
  async publishPRReview(
    prId: number,
    publication: PRReviewPublication,
  ): Promise<PRReviewPublicationResult> {
    const reviewMarker = (key: string) => `<!-- ai-workflow-review:${key} -->`;
    const marker = reviewMarker(publication.idempotencyKey);
    // The merge request's marker, on the one summary note. Only the current key is
    // ever written; prior keys are recognised because a note published before the
    // key identified the merge request carries one of those, and this is what turns
    // such a note into the note every later round edits.
    const priorKeys = publication.priorIdempotencyKeys ?? [];
    const knownMarkers = [marker, ...priorKeys.map(reviewMarker)];
    // The round's marker, and on GitLab it rides in the summary note because there
    // is no review object to hang it from. Its one job is to recognise a round this
    // adapter has already published, now that the summary marker no longer says
    // which head it describes.
    const headMarker = `<!-- ai-workflow-review-head:${publication.headSha} -->`;
    // The marker family from before findings had an identity of their own. Never
    // written again, still recognised: within one round the index it carries does
    // identify the finding, and the prior keys are the same round's earlier
    // attempts, so an attempt that failed after posting its discussions does not
    // post them twice.
    const legacyCommentMarkers = (index: number) =>
      [publication.idempotencyKey, ...priorKeys].map(
        (key) => `<!-- ai-workflow-review-comment:${key}:${index} -->`,
      );
    const existingNotes = (await this.gl.MergeRequestNotes.all(
      this.projectId,
      prId,
    )) as unknown as Array<{ id?: number; body?: string }>;
    const existingDiscussions = (await this.gl.MergeRequestDiscussions.all(
      this.projectId,
      prId,
    )) as unknown as Array<{
      id?: string;
      notes?: Array<{
        body?: string;
        resolved?: boolean;
        system?: boolean;
        author?: { username?: string };
      }>;
    }>;
    const summaryNote = existingNotes.find((note) =>
      knownMarkers.some((known) => note.body?.includes(known)),
    );
    // The caller's digests. This adapter only carries the value.
    const digests = publication.commentFindingDigests;
    // The discussions that belong to the workflow: marked with a finding digest AND
    // opened by this token. The marker alone is text anybody can paste, and the
    // author alone matches every thread this token ever opened, so two installations
    // on one project would retire each other's. Requiring both costs the pre-marker
    // discussions, which are no longer ours to touch and stay open for good; putting
    // a "Resolved" strip on somebody else's conversation is the worse error.
    const botUsername = existingDiscussions.some((discussion) =>
      readReviewFindingDigest(discussion.notes?.[0]?.body ?? ""),
    )
      ? await this.currentUsername()
      : null;
    const owned = existingDiscussions.flatMap((discussion): OwnedReviewDiscussion[] => {
      const notes = discussion.notes ?? [];
      const first = notes[0];
      const digest = readReviewFindingDigest(first?.body ?? "");
      if (digest === null) return [];
      if (
        botUsername === null ||
        first?.author?.username !== botUsername
      ) {
        return [];
      }
      return [
        {
          discussion,
          digest,
          resolved: first?.resolved === true,
          // System notes are GitLab's own bookkeeping, never a participant.
          hasHumanReply: notes.some(
            (note) =>
              note.system !== true && note.author?.username !== botUsername,
          ),
          hasSupersededNote: notes.some((note) =>
            note.body?.includes(SUPERSEDED_DISCUSSION_NOTE),
          ),
        },
      ];
    });
    const openByDigest = new Map<string, { id?: string }>();
    for (const entry of owned) {
      openByDigest.set(entry.digest, entry.discussion);
    }
    // Reported inline AND reported into the summary. A finding the cap pushed out of
    // the inline set is still standing, so its discussion must not be retired while
    // the summary lists it.
    const reported = new Set([
      ...digests,
      ...(publication.deferredFindingDigests ?? []),
    ]);
    // Which finding each still-standing discussion is about. Digest first, then the
    // legacy index, and nothing else: an unmatched discussion of ours is one whose
    // finding this round no longer reports.
    const openFor = (index: number): { id?: string } | undefined =>
      openByDigest.get(digests[index]!) ??
      existingDiscussions.find((candidate) =>
        candidate.notes?.some((note) =>
          legacyCommentMarkers(index).some((known) => note.body?.includes(known)),
        ),
      );
    const matched = publication.comments.map((_, index) => openFor(index));

    if (summaryNote?.body?.includes(headMarker) === true) {
      // This head has already been published. Re-approving is kept from the
      // original path: the approval is what a protected branch reads, and GitLab
      // drops it whenever the merge request changes.
      if (publication.decision === "approve") {
        await this.approveMergeRequestBestEffort(prId, publication.headSha);
      }
      // A retry has to be able to finish the sweep: the publish can succeed and the
      // state update that records it can be lost, so the round already being on the
      // merge request is not proof the sweep ran.
      await this.retireSupersededDiscussions(prId, owned, reported);
      return {
        id:
          summaryNote.id === undefined
            ? publication.idempotencyKey
            : String(summaryNote.id),
        commentIds: matched.map((discussion) =>
          discussion?.id ? String(discussion.id) : null,
        ),
      };
    }
    const mr = (await this.gl.MergeRequests.show(
      this.projectId,
      prId,
    )) as unknown as GitLabMR;
    const refs = mr.diff_refs;
    if (
      mr.sha !== publication.headSha ||
      !refs?.base_sha ||
      !refs.start_sha ||
      !refs.head_sha
    ) {
      throw new FatalError(
        `GitLab merge request !${prId} no longer matches reviewed head ${publication.headSha}`,
      );
    }

    const commentIds: Array<string | null> = [];
    const summaryFallbacks: string[] = [];
    const carriedOver: PRReviewInlineComment[] = [];
    for (const [index, comment] of publication.comments.entries()) {
      // The marker travels with the note because the discussion it opens is what a
      // later round has to recognise.
      const commentMarker =
        `<!-- ai-workflow-review-finding:${digests[index]!} -->`;
      const priorDiscussion = matched[index];
      if (priorDiscussion) {
        commentIds.push(
          priorDiscussion.id ? String(priorDiscussion.id) : null,
        );
        carriedOver.push(comment);
        continue;
      }
      const position = {
        position_type: "text",
        base_sha: refs.base_sha,
        start_sha: refs.start_sha,
        head_sha: refs.head_sha,
        old_path: comment.path,
        new_path: comment.path,
        new_line: comment.endLine,
        ...(comment.startLine === comment.endLine
          ? {}
          : {
              line_range: {
                start: this.gitLabLineRangePosition(
                  comment.path,
                  comment.startLine,
                  comment.startOldLine,
                ),
                end: this.gitLabLineRangePosition(
                  comment.path,
                  comment.endLine,
                  comment.endOldLine,
                ),
              },
            }),
      };
      try {
        const discussion = await this.gitLabRest<{ id?: string }>(
          `/projects/${this.encodedProjectId}/merge_requests/${prId}/discussions`,
          {
            method: "POST",
            body: {
              body: `${comment.body}\n\n${commentMarker}`,
              position,
            },
          },
        );
        commentIds.push(discussion.id ? String(discussion.id) : null);
      } catch (error) {
        if (this.getStatusCode(error) !== 400) throw error;
        console.warn(
          `GitLab rejected inline review position ${comment.path}:${comment.startLine}-${comment.endLine}; including it in the summary instead.`,
        );
        commentIds.push(null);
        summaryFallbacks.push(reviewFallbackBullet(comment));
      }
    }

    const body = [
      publication.summary,
      ...(summaryFallbacks.length === 0
        ? []
        : [
            `### Additional findings not placed inline\n${summaryFallbacks.join("\n")}`,
          ]),
      // Findings this round reports that already have a discussion. They get no new
      // note of their own, so without this section they would be missing from the
      // one artifact a reader treats as the current state, and an unfixed finding
      // would read as fixed.
      ...(carriedOver.length === 0
        ? []
        : [
            "### Findings already open on this merge request\n" +
              carriedOver.map(reviewFallbackBullet).join("\n"),
          ]),
      marker,
      headMarker,
      // Read by trigger-events.ts to drop a note this workflow produced. An
      // installation without a matchable bot login would otherwise fire a fresh
      // review trigger off its own summary on the first round of every merge
      // request.
      AI_WORKFLOW_COMMENT_MARKER,
    ].join("\n\n");
    // Edited in place from the second round on, so the merge request carries one
    // summary rather than one per head.
    const note =
      summaryNote?.id === undefined
        ? await this.gitLabRest<{ id?: number }>(
            `/projects/${this.encodedProjectId}/merge_requests/${prId}/notes`,
            { method: "POST", body: { body } },
          )
        : await this.gitLabRest<{ id?: number }>(
            `/projects/${this.encodedProjectId}/merge_requests/${prId}/notes/${summaryNote.id}`,
            { method: "PUT", body: { body } },
          );
    if (publication.decision === "approve") {
      await this.approveMergeRequestBestEffort(prId, publication.headSha);
    }
    // Only once this round's findings are on the merge request. Run earlier, a
    // failure between the sweep and the summary left every superseded discussion
    // resolved with nothing published in their place, and the merge request read as
    // reviewed and clean.
    await this.retireSupersededDiscussions(prId, owned, reported);
    return {
      id: note.id === undefined ? publication.idempotencyKey : String(note.id),
      commentIds,
    };
  }

  /**
   * Retires the discussions whose finding this round no longer reports.
   *
   * GitLab has one collapse primitive and it is "Resolved", a word that claims the
   * defect is gone. Nothing here can support that claim: a finding's identity is a
   * hash of agent prose regenerated every round, so an unmatched discussion means
   * "not reported under the same wording", not "fixed". The note is what keeps the
   * strip from lying, and it is posted BEFORE the resolve so a failure in between
   * leaves an explained open thread rather than a bare "Resolved" tick.
   */
  private async retireSupersededDiscussions(
    prId: number,
    owned: ReadonlyArray<OwnedReviewDiscussion>,
    reported: ReadonlySet<string>,
  ): Promise<void> {
    for (const entry of owned) {
      if (entry.resolved) continue;
      if (entry.discussion.id === undefined) continue;
      if (reported.has(entry.digest)) continue;
      // Somebody is talking in this thread. Leave it exactly as it is.
      if (entry.hasHumanReply) continue;
      if (!entry.hasSupersededNote) {
        await this.gitLabRest<unknown>(
          `/projects/${this.encodedProjectId}/merge_requests/${prId}/discussions/${encodeURIComponent(entry.discussion.id)}/notes`,
          { method: "POST", body: { body: SUPERSEDED_DISCUSSION_NOTE } },
        );
      }
      await this.resolveMRDiscussion(prId, entry.discussion.id);
    }
  }

  /**
   * The current token's own username, read once per adapter instance. It is what
   * separates a discussion this workflow opened from one that merely quotes its
   * marker. https://docs.gitlab.com/ee/api/users.html, "List current user".
   */
  private async currentUsername(): Promise<string | null> {
    if (this.cachedUsername === undefined) {
      const user = await this.gitLabRest<{ username?: string }>("/user", {
        method: "GET",
      });
      this.cachedUsername = user?.username ?? null;
    }
    return this.cachedUsername;
  }

  /**
   * GitLab's resolve primitive, and its collapse primitive as well: a resolved
   * thread folds into a "Resolved" strip and stops counting against the merge
   * request's unresolved threads. There is no separate hide call the way GitHub
   * has `minimizeComment`.
   *
   * https://docs.gitlab.com/ee/api/discussions.html, "Resolve a merge request
   * thread": `PUT /projects/:id/merge_requests/:iid/discussions/:discussion_id`
   * with `resolved=true`.
   */
  private async resolveMRDiscussion(
    prId: number,
    discussionId: string,
  ): Promise<void> {
    await this.gitLabRest<unknown>(
      `/projects/${this.encodedProjectId}/merge_requests/${prId}/discussions/${encodeURIComponent(discussionId)}`,
      { method: "PUT", body: { resolved: true } },
    );
  }

  /**
   * Best-effort MR approval. The approval is a protected-branch convenience, not
   * the review itself: GitLab refuses an author's approval of their own merge
   * request (and MR approvals are a paid-tier feature), so a refused approval must
   * never discard a review that is already on the merge request. It degrades to a
   * warning exactly as an unplaceable inline comment degrades to the summary.
   */
  private async approveMergeRequestBestEffort(
    prId: number,
    headSha: string,
  ): Promise<void> {
    try {
      await this.gitLabRest<unknown>(
        `/projects/${this.encodedProjectId}/merge_requests/${prId}/approve`,
        { method: "POST", body: { sha: headSha } },
      );
    } catch (error) {
      console.warn(
        `GitLab refused to approve merge request !${prId} (self-approval or approvals unavailable); the review was published without an approval.`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private gitLabLineRangePosition(
    path: string,
    newLine: number,
    oldLine: number | null | undefined,
  ) {
    // GitLab's line_code wire format requires SHA-1(path); this is an
    // identifier mandated by the API, not a cryptographic security primitive.
    const pathHash = createHash("sha1").update(path).digest("hex");
    const isNewLine = oldLine === null || oldLine === undefined;
    return {
      line_code: `${pathHash}_${oldLine ?? 0}_${newLine}`,
      type: isNewLine ? "new" : "old",
      ...(isNewLine ? {} : { old_line: oldLine }),
      new_line: newLine,
    };
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
      // GitLab caps a commit-status description at 255 characters. A failure
      // summary arrives here as "<generic> (<cause>) Diagnostic ID: <id>", which
      // reaches 288 characters, so a head slice cut the verdict AND left a
      // truncated diagnostic ID that still looks valid but correlates with
      // nothing. Keep both ends instead.
      ...(update.summary !== undefined
        ? { description: clampBothEnds(update.summary, 255) }
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

  async postPRComment(prId: number, body: string): Promise<{ url: string | null }> {
    const note = await this.gitLabRest<{ id?: number }>(
      `/projects/${this.encodedProjectId}/merge_requests/${prId}/notes`,
      { method: "POST", body: { body } },
    );
    return { url: this.buildNoteUrl(prId, note.id) };
  }

  /**
   * Reconstruct a deep link to a posted MR note. GitLab's note-create response
   * carries no MR web_url, so we rebuild it from the configured host + project
   * path: `<host>/<projectId>/-/merge_requests/<iid>#note_<id>`. Numeric project
   * ids have no web path we can build, so the link is not derivable (return null).
   */
  private buildNoteUrl(prId: number, noteId: number | undefined): string | null {
    if (noteId == null || /^\d+$/.test(this.projectId)) return null;
    const host = (this.config.host ?? "https://gitlab.com").replace(/\/+$/, "");
    return `${host}/${this.projectId}/-/merge_requests/${prId}#note_${noteId}`;
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

  /**
   * Every unresolved discussion on the merge request, as work items the ledger can
   * hand to the agent. GitLab has no "review thread" object: a plain comment is a
   * discussion with `individual_note: true`, and posting a reply to it flips it into
   * a real thread whose notes all become resolvable. That transition is why
   * `resolvable` is unconditionally true here (verified on gitlab.com, see
   * docs/plans/2026-08-21-review-ledger-spike.md): the reply the ledger is about to
   * post is exactly what earns the right to resolve.
   */
  async listReviewThreads(prId: number): Promise<ReviewThreadFeed> {
    // Taken before the first request so the settle pass treats anything written
    // while we were reading as newer than the snapshot, never as already seen.
    const snapshotAt = new Date().toISOString();
    const discussions = (await this.gl.MergeRequestDiscussions.all(
      this.projectId,
      prId,
    )) as unknown as GitLabDiscussion[];
    const botUsername = await this.currentUsername();

    const candidates = discussions.flatMap((discussion) => {
      if (discussion.id === undefined) return [];
      // System notes are GitLab's own bookkeeping ("assigned to", "changed the
      // description"), never a participant in the conversation.
      const notes = (discussion.notes ?? []).filter((note) => note.system !== true);
      const first = notes[0];
      if (first === undefined) return [];
      // GitLab carries the resolved flag on the notes, not on the discussion.
      if (first.resolved === true) return [];
      return [{ id: discussion.id, notes, first }];
    });

    const mapped = candidates
      .map(({ id, notes, first }) => {
        const mappedNotes = notes.map((note) => ({
          author: note.author?.username ?? "unknown",
          body: String(note.body ?? ""),
          createdAt: String(note.created_at ?? ""),
          isLedgerReply: readReviewLedgerMarker(String(note.body ?? "")) !== null,
        }));
        const thread: ReviewThread = {
          threadId: id,
          // Rewritten once the array order is final; aliases number the output.
          alias: "",
          source: this.reviewThreadSource(first, botUsername),
          resolvable: true,
          awaitingHuman: mappedNotes[mappedNotes.length - 1]?.isLedgerReply === true,
          notes: mappedNotes,
        };
        const filePath = first.position?.new_path ?? first.position?.old_path;
        const line = first.position?.new_line ?? first.position?.old_line;
        if (filePath !== undefined) thread.filePath = filePath;
        if (line !== undefined) thread.line = line;
        return { thread, openedAt: parseTimestamp(first.created_at) };
      })
      .sort((left, right) => left.openedAt - right.openedAt)
      .map((entry) => entry.thread);

    // Oldest first, so a run that has to drop something drops the newest feedback,
    // which is the part most likely to still be under discussion.
    const workItems = mapped.filter((thread) => !thread.awaitingHuman);
    const awaiting = mapped.filter((thread) => thread.awaitingHuman);
    const threads = [
      ...workItems.slice(0, REVIEW_LEDGER_MAX_WORK_ITEMS),
      ...awaiting.slice(0, REVIEW_LEDGER_MAX_WORK_ITEMS),
    ];
    threads.forEach((thread, index) => {
      thread.alias = `T${index + 1}`;
    });

    // Only dropped work items count: a dropped context thread costs the agent
    // background, a dropped work item costs it a review comment it must answer.
    const truncated = Math.max(0, workItems.length - REVIEW_LEDGER_MAX_WORK_ITEMS);
    return { threads, truncated, snapshotAt };
  }

  /**
   * "bot" is this workflow's own account, the one whose replies must never be read
   * back as review feedback. `author.bot` is GitLab's flag for a project or service
   * account, which is what separates a CodeRabbit-style reviewer from a person.
   */
  private reviewThreadSource(
    first: GitLabNote,
    botUsername: string | null,
  ): ReviewThreadSource {
    const author = first.author?.username;
    if (author !== undefined && botUsername !== null && author === botUsername) {
      return "bot";
    }
    return first.author?.bot === true ? "third_party" : "human";
  }

  /**
   * Post the ledger's answer into one thread and, when the disposition earns it,
   * resolve the thread. The discussion is re-read first because the feed the agent
   * worked from is a snapshot: between reading it and settling it, a reviewer can
   * have written something nobody in this run has seen.
   *
   * Two guards, in this order. Newer non-bot activity wins over everything: we
   * still answer, but resolving would collapse a conversation that moved on.
   * Otherwise, our own marker already on the last note means a previous attempt
   * got as far as the reply, so the reply is not posted twice (reply and resolve
   * are two calls and a crash between them is the expected failure).
   */
  async settleReviewThread(
    input: SettleReviewThreadInput,
  ): Promise<SettleReviewThreadResult> {
    const { prId, thread, body, resolve, snapshotAt } = input;
    const discussionPath = `/projects/${this.encodedProjectId}/merge_requests/${prId}/discussions/${encodeURIComponent(thread.threadId)}`;
    const discussion = await this.gitLabRest<GitLabDiscussion>(discussionPath, {
      method: "GET",
    });
    const notes = (discussion.notes ?? []).filter((note) => note.system !== true);
    const botUsername = await this.currentUsername();

    const postReply = () =>
      this.gitLabRest<unknown>(`${discussionPath}/notes`, {
        method: "POST",
        body: { body },
      });

    const snapshotInstant = parseTimestamp(snapshotAt);
    // Anything not written by this token counts, third-party review bots included:
    // their note is content this run never read either.
    const movedSinceSnapshot = notes.some(
      (note) =>
        note.author?.username !== botUsername &&
        parseTimestamp(note.created_at) > snapshotInstant,
    );
    if (movedSinceSnapshot) {
      await postReply();
      return { action: "replied_without_resolve_human_activity" };
    }

    const last = notes[notes.length - 1];
    if (
      last !== undefined &&
      readReviewLedgerMarker(String(last.body ?? "")) === thread.threadId
    ) {
      return { action: "skipped_existing_reply" };
    }

    // The caller composed the body, marker included: this adapter never edits it.
    await postReply();
    if (!resolve) return { action: "replied" };
    await this.resolveMRDiscussion(prId, thread.threadId);
    return { action: "replied_and_resolved" };
  }

  /**
   * Tell the merge request that the ledger round died, once per run. Without the
   * marker this note would be re-posted on every retry of the step that reports the
   * failure, and a wall of identical apologies is worse than silence.
   */
  async postRunFailureNote(input: PostRunFailureNoteInput): Promise<void> {
    const { prId, runId, body } = input;
    const notes = (await this.gl.MergeRequestNotes.all(
      this.projectId,
      prId,
    )) as unknown as GitLabNote[];
    const alreadyReported = notes.some(
      (note) =>
        note.system !== true &&
        hasReviewLedgerFailureMarker(String(note.body ?? ""), runId),
    );
    if (alreadyReported) return;
    await this.postPRComment(prId, `${body}\n\n${reviewLedgerFailureMarker(runId)}`);
  }
}

/** GitLab timestamps carry an offset that varies by instance, so compare instants. */
function parseTimestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
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
