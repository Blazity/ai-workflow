/**
 * Custom webhook ingress: authentication, rate limits, payload mapping and dispatch.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  dispatchWebhookDelivery,
  fallbackWebhookDeliveryId,
  redispatchPendingWebhookDeliveries,
} from "./dispatch-webhook-trigger.js";
export type {
  WebhookDispatchDeps,
  WebhookDispatchGuardRejection,
  WebhookDispatchTarget,
} from "./dispatch-webhook-trigger.js";
export {
  mapWebhookPayload,
} from "./payload-mapping.js";
export type {
  WebhookMappingConfig,
  WebhookTriggerEntry,
} from "./payload-mapping.js";
export {
  DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
  WEBHOOK_INGRESS_LIMIT_PER_MINUTE,
  checkAndIncrementWebhookRate,
  sweepWebhookRateLimits,
  webhookRateWindowStart,
} from "./rate-limit.js";
export {
  getWebhookRejectionsToday,
  recordWebhookRejection,
  sweepWebhookRejectionCounters,
  webhookRejectionWindowStart,
} from "./rejection-counters.js";
export {
  resolveWebhookHeaderName,
  resolveWebhookTimestampHeaderName,
  verifyWebhookAuth,
} from "./verify.js";
export type {
  WebhookVerifiedWith,
} from "./verify.js";
