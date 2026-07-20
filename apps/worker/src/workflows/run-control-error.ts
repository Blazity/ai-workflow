import { FatalError } from "workflow";
import { WorkflowRunCancelledError } from "workflow/errors";
import { isActiveRunOwnerError } from "../lib/run-control-errors.js";
import { isRunBudgetControlError } from "./run-budget.js";

/**
 * Run-level control signals must terminate graph execution rather than enter an
 * authored block failure edge. Error identity is checked structurally because
 * Workflow serializes step errors into the workflow VM, where `instanceof`
 * does not survive. Workflow's own cancellation predicate follows the same
 * cross-VM contract.
 */
export function isRunControlError(error: unknown): boolean {
  return (
    isRunBudgetControlError(error) ||
    isActiveRunOwnerError(error) ||
    WorkflowRunCancelledError.is(error) ||
    isReplayedRunControlStepError(error)
  );
}

function isReplayedRunControlStepError(error: unknown): boolean {
  if (!FatalError.is(error) || typeof error.stack !== "string") return false;
  const firstLine = error.stack.split("\n", 1)[0]?.trim() ?? "";
  return ["RunBudgetError", "WorkflowRunCancelledError"].some(
    (name) => firstLine === name || firstLine.startsWith(`${name}:`),
  );
}
