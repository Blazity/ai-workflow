/**
 * Run telemetry: snapshots, awaiting resolution and orphan sweeps.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
 */
export {
  collectSnapshots,
} from "./collect-snapshots.js";
export {
  WATCHDOG_FAILURE_REASON_PREFIX,
  markRunBlockedOnCancel,
  markRunFailedByWatchdog,
  markRunResumed,
  resolveAwaitingRun,
  resolveAwaitingRunsForTicket,
  sweepOrphanedAwaitingRuns,
  sweepOrphanedRunningRuns,
  upsertRunSnapshots,
} from "./run-telemetry.js";
