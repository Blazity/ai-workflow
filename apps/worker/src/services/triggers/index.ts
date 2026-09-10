/**
 * Trigger ingress: every way work enters this system from outside.
 *
 * Provider webhooks (Jira, GitHub, GitLab, Slack, email delivery events), the
 * public custom webhook endpoints, and the scheduled poll all decide the same
 * question, so they share one ownership boundary: the routes above hold only
 * raw-byte capture, signature timing and the HTTP answer.
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
  handleGitHubWebhook,
} from "./github/handle-github-webhook.js";
export type {
  GitHubWebhookRequest,
} from "./github/handle-github-webhook.js";
export {
  handleGitLabWebhook,
} from "./gitlab/handle-gitlab-webhook.js";
export type {
  GitLabWebhookRequest,
} from "./gitlab/handle-gitlab-webhook.js";
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
} from "./trigger-http-error.js";
