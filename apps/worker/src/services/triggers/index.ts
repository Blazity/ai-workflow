/**
 * Trigger ingress: every way work enters this system from outside.
 *
 * What is left here is the ingress core still owns: the public custom webhook
 * endpoints, the scheduled poll, and what a ticket event MEANS for a run. Every
 * provider answers at the generic `/webhooks/<id>` route and translates its own
 * deliveries, so no provider's handler is in this cluster any more.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  WEBHOOK_MAX_BODY_BYTES,
  deliverCustomWebhook,
} from "./custom-webhooks/deliver.js";
export type {
  CustomWebhookOutcome,
  CustomWebhookRequest,
  WebhookRejectionReason,
} from "./custom-webhooks/deliver.js";
export {
  createWebhookDispatchDeps,
} from "./custom-webhooks/dispatch-deps.js";
export {
  actOnTicketEvent,
} from "./ticket-events.js";
export type {
  TicketEventOutcome,
} from "./ticket-events.js";
export {
  cronRequestIsAuthorized,
} from "./polling/cron-authorization.js";
export {
  runPollPass,
} from "./polling/poll-pass.js";
export {
  TriggerHttpError,
} from "../../infra/trigger-http-error.js";
