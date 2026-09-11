/**
 * A run's life from reservation to cancellation: ownership, start, stall watchdog, drain and reconcile.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  assertActiveRunOwner,
  assertActiveRunOwnerState,
} from "../../db/repositories/active-runs.js";
export type {
  ActiveRunOwner,
} from "../../db/repositories/active-runs.js";
export { ActiveRunOwnerError } from "../../db/repositories/active-run-owner-error.js";
export {
  cancelRun,
  cancelRunDetailed,
  cancelConnectedRunForOperator,
  cancelRunForOperator,
  cancelSubjectRun,
} from "./cancel-run.js";
export type {
  CancelRunForOperatorResult,
  CancelRunTarget,
} from "./cancel-run.js";
export {
  cancelRunAsOperator,
} from "./cancel-run-request.js";
export {
  reconcileRuns,
} from "./reconcile.js";
export {
  ACTIVE_RUN_OWNER_ERROR_SENTINEL,
  isActiveRunOwnerError,
} from "./run-control-errors.js";
export {
  emptyRunDetail,
  readRunDetail,
} from "./run-detail-read.js";
export type {
  RunDetailPayload,
} from "./run-detail-read.js";
export {
  listDashboardRuns,
  listLiveRuns,
  listWorkflowAggregates,
  readRunBlockStatuses,
} from "./run-reads.js";
export type {
  DashboardRunsPage,
} from "./run-reads.js";
export {
  connectedCostAgg,
  connectedListRuns,
  connectedListRunsForTicket,
  connectedRunKpis,
  connectedWorkflowAgg,
  costAgg,
  listRuns,
  listRunsForTicket,
  parseSearch,
  parseWindow,
  runKpis,
  workflowAgg,
} from "./dashboard-run-data.js";
export type { TimeWindow } from "./dashboard-run-data.js";
export {
  fetchConnectedRunDetailFromDb,
  fetchConnectedRunRefs,
  fetchRunDetailFromDb,
  fetchRunRefs,
} from "./durable-run-detail.js";
export type { FetchRunDetailFromDbOptions } from "./durable-run-detail.js";
export {
  MAX_REPLAY_PAGE_LIMIT,
  RunObservationStoreError,
  getConnectedRunReplay,
  getConnectedRunReplayAttempt,
  getConnectedRunReplayAvailability,
  getRunReplay,
  getRunReplayAttempt,
  getRunReplayAvailability,
  readRunReplay,
  readRunReplayAttempt,
} from "./run-replay-read.js";
export {
  STARTUP_DEADLINE_MS,
} from "./run-start-constants.js";
export {
  orgSubjectKey,
  prSubjectKey,
  repoOwner,
  repoSubjectKey,
  scheduleSubjectKey,
  ticketSubjectKey,
  webhookSubjectKey,
} from "./subject-key.js";
