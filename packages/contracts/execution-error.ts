import { EXECUTION_DIAGNOSTIC_PREFIX } from "./domain";
import type { RunFailureCode } from "./run-registry";

/**
 * Which kind of cause ended a block, and therefore which safe sentence a
 * surface leads a failure with. The worker owns the sentences; the vocabulary
 * lives here because the scheduler, the run registry and the diagnosis tools
 * all classify by it.
 */
export type ExecutionErrorCategory =
  | "sandbox"
  | "provider"
  | "engine"
  | "binding"
  | "timeout"
  | "parsing"
  | "schema"
  | "checks"
  /**
   * The deployment is configured in a way that forbids what the run was asked
   * to do, and no retry and no provider can change that: a repository the
   * catalog does not enable, a catalog that enables nothing this run can
   * reach. Distinct from every other member because the fix is an operator
   * editing a setting, not an engineer reading a log, and because classifying
   * it as `engine`, `provider` or `sandbox` sends that operator to blame a
   * platform that did exactly what it was told.
   */
  | "configuration"
  | "unknown";

/**
 * The execution error a failed block reports, as plain data.
 *
 * The scheduler produces exactly this shape and never the worker's
 * `WorkflowExecutionError` class, so scheduling can be reasoned about (and
 * later moved) without the engine. A worker-side error may carry more than
 * this (a redacted provider-protocol diagnostic, for instance); anything that
 * only the engine understands extends this interface rather than widening it.
 */
export interface ExecutionErrorShape {
  category: ExecutionErrorCategory;
  /** Safe text that may be persisted or shown to a user. */
  message: string;
  /** Internal context for correlated server logs. Never persist or expose it. */
  detail?: string;
  phase?: string;
  /**
   * The machine-readable cause, for the failures that have one. `category` is
   * which safe sentence to lead with and is far too coarse to act on: every
   * unreachable integration and every misconfigured repository share
   * `configuration`. Absent means this failure carries no code, which is true
   * of almost all of them.
   */
  failureCode?: RunFailureCode;
}

/**
 * What a run records about the failure that ended it: the safe part of the
 * error plus where it happened and under which diagnostic id.
 *
 * `detail` is deliberately absent. This state crosses persistence and customer
 * surfaces, and the raw cause belongs only in correlated server logs.
 */
export interface WorkflowExecutionErrorState {
  category: ExecutionErrorCategory;
  message: string;
  phase?: string;
  diagnosticId: string;
  nodeId: string;
  attempt: number;
  /** Carried from the block's error so the run's durable record can hold it
   *  beside the sentence. Absent on every failure that has no code. */
  failureCode?: RunFailureCode;
}

/**
 * The single way to mint an execution error state. The diagnostic id is
 * derived here so that every producer, the scheduler included, spells it the
 * same way: an operator correlates a customer-facing message with a server log
 * by that string alone.
 */
export function createWorkflowExecutionErrorState(
  runId: string,
  nodeId: string,
  attempt: number,
  error: ExecutionErrorShape,
): WorkflowExecutionErrorState {
  return {
    category: error.category,
    message: error.message,
    ...(error.phase ? { phase: error.phase } : {}),
    ...(error.failureCode ? { failureCode: error.failureCode } : {}),
    diagnosticId: `${EXECUTION_DIAGNOSTIC_PREFIX}${runId}-${nodeId}-${attempt}`,
    nodeId,
    attempt,
  };
}
