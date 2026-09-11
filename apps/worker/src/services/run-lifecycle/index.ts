/** Cross-cluster cancellation surface. Load the stateful implementation only on use. */
export type {
  CancelRunForOperatorResult,
  CancelRunTarget,
} from "./cancel-run.js";

export async function cancelRun(
  ...args: Parameters<typeof import("./cancel-run.js").cancelRun>
) {
  return (await import("./cancel-run.js")).cancelRun(...args);
}

export async function cancelRunForOperator(
  ...args: Parameters<typeof import("./cancel-run.js").cancelRunForOperator>
) {
  return (await import("./cancel-run.js")).cancelRunForOperator(...args);
}

export async function cancelRunDetailed(
  ...args: Parameters<typeof import("./cancel-run.js").cancelRunDetailed>
) {
  return (await import("./cancel-run.js")).cancelRunDetailed(...args);
}

export async function cancelSubjectRun(
  ...args: Parameters<typeof import("./cancel-run.js").cancelSubjectRun>
) {
  return (await import("./cancel-run.js")).cancelSubjectRun(...args);
}

export async function reconcileRuns(
  ...args: Parameters<typeof import("./reconcile.js").reconcileRuns>
) {
  return (await import("./reconcile.js")).reconcileRuns(...args);
}
