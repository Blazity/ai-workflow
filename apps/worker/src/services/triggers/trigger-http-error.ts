/**
 * The trigger refusal, named inside this cluster for the app tier.
 *
 * The class itself lives in `infra/trigger-http-error.ts`, because the email and
 * Slack services throw it too and must not import this cluster to do so. A route
 * may import `services`, not `infra` (ADR-001), so the webhook routes that map
 * the refusal onto a status keep naming this module.
 */
export { TriggerHttpError } from "../../infra/trigger-http-error.js";
