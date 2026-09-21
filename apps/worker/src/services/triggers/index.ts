/**
 * Trigger ingress: every way work enters this system from outside.
 *
 * What is left here is the ingress core still owns: the issue tracker webhook,
 * the public custom webhook endpoints and the scheduled poll. Every provider
 * whose package has landed answers at the generic `/webhooks/<id>` route and
 * translates its own deliveries, so its handler is not in this cluster.
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
  handleJiraWebhook,
} from "./jira/handle-jira-webhook.js";
export type {
  JiraWebhookRequest,
} from "./jira/handle-jira-webhook.js";
export {
  cronRequestIsAuthorized,
} from "./polling/cron-authorization.js";
export {
  runPollPass,
} from "./polling/poll-pass.js";
export {
  TriggerHttpError,
} from "../../infra/trigger-http-error.js";
