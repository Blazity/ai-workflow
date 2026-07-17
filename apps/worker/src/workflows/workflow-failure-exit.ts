export interface WorkflowFailureExitDeps {
  logFailure(): Promise<void>;
  moveTicket(): Promise<void>;
  notifyTicket(): Promise<void>;
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
