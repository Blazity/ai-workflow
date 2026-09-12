/**
 * The engine's typing of an execution error: the class a caught failure is
 * recognised by, and the sentence a user reads.
 *
 * It sits next to `run-budget.ts` rather than in `workflow-definition/` because
 * both are worker-only. The data these helpers carry is the contracts shape
 * (`WorkflowExecutionErrorState`), so the scheduler mints and records a failure
 * without any of it.
 */
import type { WorkflowExecutionErrorState } from "@shared/contracts";

export function formatExecutionErrorForUser(
  error: Pick<WorkflowExecutionErrorState, "message" | "diagnosticId">,
): string {
  return `${error.message} Diagnostic ID: ${error.diagnosticId}`;
}

export class WorkflowExecutionError extends Error {
  readonly code: string;

  constructor(error: WorkflowExecutionErrorState) {
    super(formatExecutionErrorForUser(error));
    this.name = "WorkflowExecutionError";
    this.code = error.diagnosticId;
  }
}
