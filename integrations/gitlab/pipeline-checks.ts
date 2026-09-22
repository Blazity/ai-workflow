import type { PullRequestFailedCheck, VcsOpaqueHandle } from "@integrations/sdk";

/**
 * How a failed GitLab pipeline becomes the failed checks a trigger names.
 *
 * One home, because three readers need the same answer and drifted apart when
 * each had its own: the Pipeline Hook normalizer, the head re-read that binds a
 * delivery, and the manual dispatch snapshot. A handle minted by one of them is
 * compared with a handle minted by another through `sameHandle`, so the shapes
 * here are the identity of a GitLab check.
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

function handle(value: Readonly<Record<string, string | number | null>>): VcsOpaqueHandle {
  return value as unknown as VcsOpaqueHandle;
}
