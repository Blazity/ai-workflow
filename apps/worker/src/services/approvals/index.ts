/**
 * Plan-approval dispatch: turns an approved plan into a new run.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
 */
export {
  dispatchPlanApproved,
} from "./dispatch.js";
