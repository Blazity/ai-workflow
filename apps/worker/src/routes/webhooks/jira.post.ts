import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { TriggerHttpError, handleJiraWebhook } from "../../services/triggers/index.js";

/**
 * Jira webhook handler - triggers the same dispatch logic as the cron poller.
 *
 * Configure in Jira (Settings, System, Webhooks) with:
 *   URL:    https://<your-domain>/webhooks/jira
 *   Secret: <JIRA_WEBHOOK_SECRET>
 *   Events: Issue updated
 *
 * Auth: X-Hub-Signature HMAC (Jira signs the body when a secret is set)
 *
 * The webhook fires immediately when a ticket changes, eliminating the
 * up-to-1-minute polling delay.
 *
 * This file is the transport adapter: raw bytes and the signature header in, the
 * service's answer out. Signature verification runs on those exact bytes inside
 * the service, before anything parses them.
 */
export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    return await handleJiraWebhook({
      rawBody,
      signatureHeader: getHeader(event, "x-hub-signature"),
    });
  } catch (error) {
    if (error instanceof TriggerHttpError) {
      throw createError({
        statusCode: error.statusCode,
        statusMessage: error.statusMessage,
        ...(error.data ? { data: error.data } : {}),
      });
    }
    throw error;
  }
});
