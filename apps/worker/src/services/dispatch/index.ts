/**
 * Trigger ingestion and run dispatch: eligibility, rate limits, delivery bookkeeping and autofix caps.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
 */
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
  listPendingTriggers,
} from "./trigger-delivery-store.js";
export {
  isGateCheckName,
  normalizeGitHubEvents,
  normalizeGitLabEvents,
} from "./trigger-events.js";
export type {
  TriggerEvent,
} from "./trigger-events.js";
export {
  enforceTriggerRateLimit,
  getTriggerRejectionsToday,
  resolveTriggerRateLimit,
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
