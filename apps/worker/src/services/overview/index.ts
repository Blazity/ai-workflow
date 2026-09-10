/**
 * Read models the dashboard renders: runs, workflows, block statuses, evals and run detail.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  attributeRunModel,
} from "./attribute-run-model.js";
export {
  collectAwaitingRuns,
} from "./collect-awaiting-store.js";
export {
  collectBlockStatuses,
} from "./collect-block-statuses.js";
export {
  collectEvals,
} from "./collect-evals.js";
export {
  collectLiveRuns,
} from "./collect-live-runs.js";
export {
  collectRunDetail,
} from "./collect-run-detail.js";
export type {
  RunDetailSource,
} from "./collect-run-detail.js";
export {
  STATUS_MAP,
  mapWorkflow,
} from "./collect-runs.js";
export type {
  RunsLister,
  WorkflowRunRecord,
} from "./collect-runs.js";
export {
  registryRows,
} from "./collect-workflows.js";
export {
  resolveRunDetail,
} from "./resolve-run-detail.js";
export {
  sanitizeRunDetailForResponse,
  sanitizeRunError,
  sanitizeRunSteps,
} from "./sanitize-run-detail.js";
export {
  getWorkflowRegistry,
} from "./workflow-registry.js";
