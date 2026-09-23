import { isRunControlError } from "../helpers/run-control-error.js";

export interface WorkflowFailureExitDeps {
  logFailure(): Promise<void>;
  /** State the reason on the ticket. Runs BEFORE the backlog move: that move
   *  fires the self-triggered "ticket left the AI column" webhook, and a comment
   *  attempted after it races the ownership CAS the webhook trips. */
  commentFailure(): Promise<void>;
  moveTicket(): Promise<void>;
  /** Best effort: whether it arrived never changes the run's outcome. */
  notifyTicket(): Promise<unknown>;
  /**
   * Present exactly when a pull request event started the run. Such a run
   * reports its failure on that pull request, and it never parks the linked
   * ticket: the ticket's place on the board belongs to the ticket's own work,
   * and a failed autofix moving it back to the backlog while its pull request
   * is open says the work was abandoned when it was not.
   */
  pullRequest?: { note(): Promise<unknown> };
}

export interface UnhandledWorkflowErrorDeps {
  recordBlockFailure(error: unknown): Promise<void>;
  applyDefaultFailure(error: unknown): Promise<void>;
}

/**
 * Preserve ticket failure side effects for correlated runs while keeping a
 * review-safe PR-only subject completely outside issue tracking and messaging.
 * A run a pull request started says so on the pull request, and comments on a
 * linked ticket without moving it.
 */
export async function handleWorkflowFailureExit(
  ticketKey: string | undefined,
  deps: WorkflowFailureExitDeps,
): Promise<void> {
  const runOnce = async (label: string, task: () => Promise<unknown>) => {
    try {
      await task();
    } catch (error) {
      if (isRunControlError(error)) throw error;
      console.error(`Workflow failure ${label} failed:`, error);
    }
  };

  await runOnce("logging", deps.logFailure);
  if (deps.pullRequest) await runOnce("pull request note", deps.pullRequest.note);
  if (!ticketKey) return;
  await runOnce("ticket comment", deps.commentFailure);
  if (!deps.pullRequest) await runOnce("ticket parking", deps.moveTicket);
  await runOnce("notification", deps.notifyTicket);
}

/**
 * Run-control signals stop the run itself. They must not be rewritten as a
 * failure of whichever authored block happened to be active, nor execute the
 * ordinary backlog/notification failure policy.
 */
export async function handleUnhandledWorkflowError(
  error: unknown,
  deps: UnhandledWorkflowErrorDeps,
): Promise<void> {
  if (isRunControlError(error)) return;
  await deps.recordBlockFailure(error);
  await deps.applyDefaultFailure(error);
}

/**
 * The ticket comment for a run a pull request started. The person reading the
 * ticket did not start this run and may not know it exists, so the comment
 * names the pull request and the workflow before the reason.
 */
export function pullRequestRunFailureComment(input: {
  workflow: string;
  pullRequestUrl: string;
  reason: string;
}): string {
  return `The "${input.workflow}" workflow run on pull request ${input.pullRequestUrl} failed: ${input.reason}`;
}
