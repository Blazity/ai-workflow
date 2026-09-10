/**
 * Plan-approval dispatch: turns an approved plan into a new run.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  ApprovalStoreError,
  approveApproval,
  listDashboardApprovals,
  rejectApproval,
} from "./approval-decisions.js";
export type {
  ApprovalDecisionOutcome,
} from "./approval-decisions.js";
export {
  dispatchPlanApproved,
} from "./dispatch.js";
