import type { RunFailureCode } from "@shared/contracts";
import { executionError, type BlockExecutionResult } from "@shared/workflow-graph";

/**
 * A pull request run whose pull request moved on before the run reached it:
 * a newer commit arrived, or the pull request was closed or merged.
 *
 * That is not a failure, and every surface has to say so the same way. On
 * production run wrun_01M3B9X8SHGCE0KQK4YJ0F71VW (definition 12, 2026-09-25)
 * the pull request was closed seven seconds before create_pr_check looked at
 * it; the run failed as "An external service could not complete this block",
 * runs.diagnose sent the operator to the AI provider's status page, and the bot
 * commented "failed on this pull request" on a closed pull request. The
 * sentences and the codes live here, and the blocks that notice, the engine
 * that ends the run, the dispatcher that stops a superseded run and the
 * diagnosis that reads it all import them.
 *
 * Pure: no clock, no database, no provider. The callers bring what they saw.
 */

export type PullRequestMovedOn =
  | { kind: "new_commit"; headSha: string }
  | { kind: "closed"; state: "closed" | "merged" };

/**
 * What a pull request step returns instead of throwing when the pull request
 * moved on. A value, not an error: a step error crosses into the workflow as a
 * serialized FatalError whose identity does not survive, and a step that
 * resolves keeps its recorded result shape for every run that replays it.
 */
export interface PullRequestMovedOnResult {
  movedOn: PullRequestMovedOn;
}

/**
 * The provider summary of a check closed because a newer commit replaced its
 * head, and the reason the trigger dispatcher records on the previous run it
 * stops for the same cause (services/dispatch/dispatch-trigger.ts).
 */
export const SUPERSEDED_BY_NEWER_COMMIT = "Superseded by a newer pull request commit.";

const CODES: Record<PullRequestMovedOn["kind"], RunFailureCode> = {
  new_commit: "pull_request_moved_on.new_commit",
  closed: "pull_request_moved_on.closed",
};

/** Whether the pull request the run was started for is still the one in front
 *  of it, and if not, how it moved on. */
export function pullRequestMovedOn(
  expectedHeadSha: string,
  current: { headSha: string; state: "open" | "closed" | "merged" },
): PullRequestMovedOn | null {
  if (current.state !== "open") return { kind: "closed", state: current.state };
  if (current.headSha !== expectedHeadSha) {
    return { kind: "new_commit", headSha: current.headSha };
  }
  return null;
}

export function isPullRequestMovedOnResult(
  value: unknown,
): value is PullRequestMovedOnResult {
  if (!value || typeof value !== "object" || !("movedOn" in value)) return false;
  const movedOn = (value as { movedOn: unknown }).movedOn;
  return (
    !!movedOn &&
    typeof movedOn === "object" &&
    ((movedOn as { kind?: unknown }).kind === "new_commit" ||
      (movedOn as { kind?: unknown }).kind === "closed")
  );
}

/**
 * The run's reason, in words a person reading the pull request's run list
 * understands. It names the newer commit so it can be matched against the pull
 * request, and it only promises a run for that commit when this graph starts on
 * pull request updates, because a graph that starts only on "ready for review"
 * sends nothing after it.
 */
function pullRequestMovedOnReason(
  movedOn: PullRequestMovedOn,
  input: { repoPath: string; prNumber: number; newCommitStartsARun: boolean },
): string {
  const pr = `Pull request ${input.repoPath}#${input.prNumber}`;
  if (movedOn.kind === "closed") {
    return `${pr} was ${movedOn.state} before this run finished, so the run stopped: nothing failed and there is nothing left for it to do.`;
  }
  const next = input.newCommitStartsARun
    ? "The newer commit gets its own run."
    : "This workflow does not start on new commits, so nothing runs for the newer one automatically.";
  return `${pr} moved on to a newer commit (${movedOn.headSha.slice(0, 7)}) before this run finished, so the run stopped: nothing failed. ${next}`;
}

/**
 * The block result that ends the run as moved on. It travels the scheduler's
 * execution-error path because that is the only way a block stops a walk, and
 * the code on it is what makes the engine end the run "blocked" instead of
 * running the failure exit (engine/agent-workflow.ts). "unknown" because no
 * failure category describes it and the explicit sentence replaces the
 * category's lead anyway.
 */
export function pullRequestMovedOnError(
  movedOn: PullRequestMovedOn,
  input: {
    pr: { repoPath: string; prNumber: number };
    /** The graph this run walks, to know whether a newer commit starts one. */
    definitionNodes: readonly { type: string }[];
    phase: string;
  },
): Extract<BlockExecutionResult, { kind: "execution_error" }> {
  const reason = pullRequestMovedOnReason(movedOn, {
    repoPath: input.pr.repoPath,
    prNumber: input.pr.prNumber,
    newCommitStartsARun: input.definitionNodes.some(
      (node) => node.type === "trigger_pr_updated",
    ),
  });
  return executionError(reason, {
    category: "unknown",
    message: reason,
    phase: input.phase,
    failureCode: CODES[movedOn.kind],
  });
}

/** Which way the pull request moved on, read off a recorded code, or null for
 *  every other code and for none. */
export function pullRequestMovedOnKind(
  code: RunFailureCode | null | undefined,
): PullRequestMovedOn["kind"] | null {
  if (code === CODES.new_commit) return "new_commit";
  if (code === CODES.closed) return "closed";
  return null;
}
