import {
  ScenarioViolation,
  type ScenarioInvocation,
  type ScenarioOutcome,
} from "./harness.js";

function describeInvocation(invocation: ScenarioInvocation): string {
  return `"${invocation.nodeId}" (attempt ${invocation.attempt}, scope "${invocation.activationScopeId}")`;
}

/**
 * Asserts that `later` could not have started until `earlier` had finished.
 *
 * This is the only ordering claim a scenario may make. A bare start-order array
 * says nothing: two blocks appearing in order proves neither that they ran
 * sequentially nor that they ran together, because admission order and
 * completion order are independent. Concurrency is proved structurally with a
 * barrier instead; sequencing is proved here, against the scheduler's own hook
 * sequence.
 */
export function expectStartsAfterFinishOf(
  later: ScenarioInvocation,
  earlier: ScenarioInvocation,
): void {
  if (earlier.finishSeq === undefined) {
    throw new ScenarioViolation(
      `Cannot order ${describeInvocation(later)} after ${describeInvocation(earlier)}: the earlier invocation never reported a finish.`,
    );
  }
  if (later.startSeq === undefined) {
    throw new ScenarioViolation(
      `Cannot order ${describeInvocation(later)} after ${describeInvocation(earlier)}: the later invocation never reported a start.`,
    );
  }
  if (later.startSeq <= earlier.finishSeq) {
    throw new ScenarioViolation(
      `Expected ${describeInvocation(later)} to start only after ${describeInvocation(earlier)} finished, but the scheduler started it first.`,
    );
  }
}

/**
 * Asserts that none of the named blocks reached a block executor.
 *
 * Counting records is the wrong test: a trigger the run did not fire, a Branch
 * and a Loop all leave records without ever running a block, so
 * `invocationsOf(id)` being non-empty does not mean the block ran. This filters
 * on the executor boundary instead.
 */
export function expectNeverInvoked(
  outcome: ScenarioOutcome,
  nodeIds: readonly string[],
): void {
  const ran = outcome.invocations.filter(
    (invocation) =>
      invocation.enteredExecutor && nodeIds.includes(invocation.nodeId),
  );
  if (ran.length === 0) return;
  throw new ScenarioViolation(
    `Expected ${nodeIds.map((nodeId) => `"${nodeId}"`).join(", ")} never to run, but the scheduler ran ${ran.map(describeInvocation).join("; ")}.`,
  );
}
