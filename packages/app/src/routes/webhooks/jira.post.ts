import { defineEventHandler, readRawBody, getHeader, createError } from "nitro/h3";
import { createLogger, parseJiraWebhook } from "@blazebot/shared";
import { appEnv } from "../../env.js";
import { verifyJiraWebhookSignature } from "../../lib/jira-signature.js";
import { routeTicketTransition } from "../../lib/webhook-router.js";

const logger = createLogger();

export default defineEventHandler(async (event) => {
  const rawBodyText = await readRawBody(event, "utf-8");
  if (!rawBodyText) {
    logger.warn({ path: "/webhooks/jira" }, "webhook_validation_failed");
    throw createError({ statusCode: 401, message: "invalid signature" });
  }

  const rawSignature = getHeader(event, "x-hub-signature");
  const valid = verifyJiraWebhookSignature(
    Buffer.from(rawBodyText, "utf-8"),
    rawSignature,
    appEnv.JIRA_WEBHOOK_SECRET,
  );

  if (!valid) {
    logger.warn({ path: "/webhooks/jira" }, "webhook_validation_failed");
    throw createError({ statusCode: 401, message: "invalid signature" });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBodyText);
  } catch {
    logger.warn({ path: "/webhooks/jira" }, "webhook_invalid_json");
    throw createError({ statusCode: 400, message: "invalid JSON body" });
  }

  const webhookEvent = parseJiraWebhook(body);
  if (webhookEvent) {
    logger.info(
      { ticketId: webhookEvent.ticketId, type: webhookEvent.type, triggeredBy: webhookEvent.triggeredBy },
      "webhook_received",
    );
    await routeTicketTransition(webhookEvent);
  }

  return { ok: true };
});
