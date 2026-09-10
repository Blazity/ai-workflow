/**
 * Deployment identity and system-health probes, observations and scan storage.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
 */
export {
  deploymentIdentity,
} from "./deployment-identity.js";
export {
  readSystemHealthScan,
  saveSystemHealthScan,
} from "./last-scan.js";
export {
  collectDeploymentSystemHealth,
} from "./probes.js";
export {
  observeProviderWebhook,
} from "./provider-webhook-observation.js";
