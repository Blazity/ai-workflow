/**
 * Run telemetry: snapshots, awaiting resolution and orphan sweeps.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  collectConnectedSnapshots,
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
} from "../../db/repositories/runs/telemetry.js";
