/**
 * Trigger ingestion and run dispatch: eligibility, rate limits, delivery bookkeeping and autofix caps.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  readDispatchCapacity,
} from "./capacity-snapshot.js";
export {
  dispatchTriggerEvent,
  drainOldestPendingTrigger,
  isConfiguredTriggerRepository,
  selectEligibleEvent,
  triggerNodeParams,
} from "./dispatch-trigger.js";
export type {
  DispatchTriggerResult,
} from "./dispatch-trigger.js";
export {
  capacityConsumerCount,
  claimSubjectRun,
  claimTicketRun,
  dispatchTicket,
  envTriggerRateLimitDefault,
  reserveSubjectWithinCapacity,
  triggerNodeRateLimitParams,
} from "./dispatch.js";
export {
  recordIngestionFailure,
} from "./ingestion-diagnostic.js";
export {
  dispatchPostPrGateWebhook,
} from "./post-pr-gate-dispatch.js";
export {
  filterAllowedRepositories,
  filterRepositoriesForScope,
  isRepoAllowed,
  isRepoAllowedForScope,
} from "./repo-allowlist.js";
export {
  listConnectedPendingTriggers,
  listPendingTriggers,
} from "../../engine/support/trigger-delivery-store.js";
export {
  isGateCheckName,
  normalizeGitHubEvents,
  normalizeGitLabEvents,
} from "./trigger-events.js";
export type {
  TriggerEvent,
} from "./trigger-events.js";
export {
  enforceConnectedTriggerRateLimit,
  enforceTriggerRateLimit,
  getTriggerRejectionsToday,
  resolveTriggerRateLimit,
  sweepConnectedTriggerRateLimits,
  sweepConnectedTriggerRejectionCounters,
  sweepTriggerRateLimits,
  sweepTriggerRejectionCounters,
  triggerRateLimitLogFields,
} from "./trigger-rate-limit.js";
export type {
  TriggerRateLimitConfig,
  TriggerRateLimitDecision,
  TriggerRateLimitKey,
  TriggerRateLimitNodeParams,
} from "./trigger-rate-limit.js";
