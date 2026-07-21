import { isRunControlError } from "./run-control-error.js";

export interface WorkflowFailureExitDeps {
  logFailure(): Promise<void>;
  moveTicket(): Promise<void>;
  notifyTicket(): Promise<void>;
}

export interface UnhandledWorkflowErrorDeps {
  recordBlockFailure(error: unknown): Promise<void>;
  applyDefaultFailure(error: unknown): Promise<void>;
}

/**
 * Preserve ticket failure side effects for correlated runs while keeping a
 * review-safe PR-only subject completely outside issue tracking and messaging.
 */
export async function handleWorkflowFailureExit(
  ticketKey: string | undefined,
  deps: WorkflowFailureExitDeps,
): Promise<void> {
  await deps.logFailure();
  if (!ticketKey) return;
  await deps.moveTicket();
  await deps.notifyTicket();
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
