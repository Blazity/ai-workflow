import { defineEventHandler, getHeader, readRawBody, createError } from "h3";
import { env } from "../../../env.js";
import {
  verifyJiraWebhookSignature,
  parseJiraWebhookEvent,
} from "../../lib/jira-webhook.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { createAdapters } from "../../lib/adapters.js";
import { logger } from "../../lib/logger.js";

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event);
  if (!rawBody) {
    throw createError({ statusCode: 400, statusMessage: "Empty body" });
  }

  const signature = getHeader(event, "x-hub-signature");
  if (
    !verifyJiraWebhookSignature(rawBody, signature, env.JIRA_WEBHOOK_SECRET)
  ) {
    throw createError({ statusCode: 401, statusMessage: "Invalid signature" });
  }

  const payload = JSON.parse(rawBody);
  const { ticketKey, relevant } = parseJiraWebhookEvent(payload, env.COLUMN_AI);

  if (!relevant) {
    logger.info(
      { ticketKey, event: payload.webhookEvent },
      "webhook_event_ignored",
    );
    return { ok: true, dispatched: false };
  }

  logger.info({ ticketKey }, "webhook_dispatching");

  const adapters = createAdapters();
  const result = await dispatchTicket(
    ticketKey,
    adapters,
    env.MAX_CONCURRENT_AGENTS,
  );

  logger.info({ ticketKey, ...result }, "webhook_dispatch_result");

  return {
    ok: true,
    dispatched: result.started,
    runId: result.runId,
    reason: result.reason,
  };
});
