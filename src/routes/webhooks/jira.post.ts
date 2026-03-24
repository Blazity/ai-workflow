import { defineEventHandler, getHeader, readRawBody, createError } from "h3";
import { getRun } from "workflow/api";
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
  const { ticketKey, action } = parseJiraWebhookEvent(payload, env.COLUMN_AI);

  if (action === "ignore") {
    logger.info(
      { ticketKey, event: payload.webhookEvent },
      "webhook_event_ignored",
    );
    return { ok: true, action: "ignored" };
  }

  const adapters = createAdapters();

  if (action === "cancel") {
    const runId = await adapters.runRegistry.getRunId(ticketKey);
    if (!runId) {
      logger.info({ ticketKey }, "webhook_cancel_no_active_run");
      return { ok: true, action: "cancel", cancelled: false };
    }

    try {
      const run = getRun(runId);
      await run.cancel();
    } catch (err) {
      logger.warn(
        { ticketKey, runId, error: (err as Error).message },
        "webhook_cancel_run_error",
      );
    }

    await adapters.runRegistry.unregister(ticketKey).catch(() => {});
    logger.info({ ticketKey, runId }, "webhook_cancelled_run");
    return { ok: true, action: "cancel", cancelled: true, runId };
  }

  logger.info({ ticketKey }, "webhook_dispatching");

  const result = await dispatchTicket(
    ticketKey,
    adapters,
    env.MAX_CONCURRENT_AGENTS,
  );

  logger.info({ ticketKey, ...result }, "webhook_dispatch_result");

  return {
    ok: true,
    action: "dispatch",
    dispatched: result.started,
    runId: result.runId,
    reason: result.reason,
  };
});
