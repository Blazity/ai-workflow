/**
 * Operator-initiated dispatch of a workflow trigger node, its preflight and recovery.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  ManualDispatchError,
} from "./errors.js";
export { toManualDispatchHttpError } from "./http.js";
export {
  dispatchManualWorkflow,
  dispatchConnectedManualWorkflow,
  preflightConnectedManualDispatch,
  preflightManualDispatch,
  recoverManualDispatches,
} from "./service.js";
