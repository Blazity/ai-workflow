import type {
  PullRequestFailedCheck,
  VcsHandleIdentity,
  VcsOpaqueHandle,
} from "@integrations/sdk";

/**
 * How a failed GitLab pipeline becomes the failed checks a trigger names.
 *
 * One home, because three readers need the same answer and drifted apart when
 * each had its own: the Pipeline Hook normalizer, the head re-read that binds a
 * delivery, and the manual dispatch snapshot. A handle minted by one of them is
 * compared with a handle minted by another through `gitlabHandleIdentity`
 * below, so the shapes here are the identity of a GitLab check.
 */

/** A job's identity: the pipeline it ran in and its own id. */
export function jobCheck(
  pipelineId: number | null,
  job: { id?: number | null; name?: unknown },
): PullRequestFailedCheck {
  return {
    handle: handle({ kind: "job", container: pipelineId, id: job.id ?? null }),
    name: String(job.name ?? "job"),
    conclusion: "failed",
  };
}

/** The pipeline as a whole, for a failure no job accounts for. */
export function pipelineCheck(pipelineId: number | null): PullRequestFailedCheck {
  return {
    handle: handle({ kind: "aggregate", id: pipelineId }),
    name: "pipeline",
    conclusion: "failed",
  };
}

/**
 * What a failed pipeline reports as its failures: the failed jobs when there
 * are any, the pipeline itself when none failed (a configuration error, or a
 * hook that omitted its builds). Never both, so a run is not told about the
 * same failure twice.
 */
export function failedPipelineChecks(
  pipelineId: number | null,
  failedJobs: ReadonlyArray<{ id?: number | null; name?: unknown }>,
): PullRequestFailedCheck[] {
  return failedJobs.length > 0
    ? failedJobs.map((job) => jobCheck(pipelineId, job))
    : [pipelineCheck(pipelineId)];
}

/** Every pipeline that fails is reported by GitLab CI itself. */
export const GITLAB_CI_PRODUCER = "gitlab-ci";

/**
 * Whether a pipeline is trusted when a workflow names no producers: only one
 * a merge request started. A pipeline from a push, a schedule or an API call
 * can run code nobody reviewed as a merge request.
 */
export function isTrustedByDefaultPipeline(source: unknown): boolean {
  return source === "merge_request_event";
}

/**
 * What a GitLab check handle holds. A job: its pipeline (`container`) and its
 * own id. The pipeline as a whole: `aggregate` and the pipeline's id.
 */
type GitLabCheckHandle = {
  kind?: string;
  id?: number | null;
  container?: number | null;
  /**
   * Only on a job rebuilt from an envelope main recorded, which named the job
   * and its pipeline but kept no id of its own. It matches any job in that
   * pipeline; the name, which core compares beside the handle, does the rest,
   * exactly as main matched it.
   */
  jobIdUnrecorded?: true;
};

function handle(value: GitLabCheckHandle): VcsOpaqueHandle {
  return value as unknown as VcsOpaqueHandle;
}

export const gitlabHandleIdentity: VcsHandleIdentity = {
  sameHandle(left, right) {
    if (!left || !right) return left === right;
    const a = left as unknown as GitLabCheckHandle;
    const b = right as unknown as GitLabCheckHandle;
    if (a.kind !== b.kind || a.container !== b.container) return false;
    return a.id === b.id || (a.kind === "job" && (a.jobIdUnrecorded || b.jobIdUnrecorded) === true);
  },

  // Main put the failed pipeline's id on the merge request (`pipelineId`) and
  // named each failed job, or the whole pipeline as `"pipeline"`.
  recordedCheckHandle(check, pullRequest) {
    const pipelineId = pullRequest.pipelineId;
    if (typeof pipelineId !== "number") return null;
    return check.name === "pipeline"
      ? handle({ kind: "aggregate", id: pipelineId })
      : handle({ kind: "job", container: pipelineId, jobIdUnrecorded: true });
  },
};
