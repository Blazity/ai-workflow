/**
 * Deployment identity and system-health probes, observations and scan storage.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
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
