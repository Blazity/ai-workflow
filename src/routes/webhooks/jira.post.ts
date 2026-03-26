import { defineEventHandler, getHeader, readRawBody, createError } from "h3";
import { env } from "../../../env.js";
import {
  verifyJiraWebhookSignature,
  parseJiraWebhookEvent,
} from "../../lib/jira-webhook.js";
import { cancelRun } from "../../lib/cancel-run.js";
import { dispatchTicket, isClaimingSentinel } from "../../lib/dispatch.js";
import { createAdapters } from "../../lib/adapters.js";
import { logger } from "../../lib/logger.js";

export default defineEventHandler(async (event) => {
  const rawBody = readVerifiedBody(event);
  const payload = JSON.parse(await rawBody);
  const { ticketKey, action } = parseJiraWebhookEvent(payload, env.COLUMN_AI);

  if (action === "ignore") {
    logger.info({ ticketKey, event: payload.webhookEvent }, "webhook_ignored");
    return { ok: true, action: "ignored" };
  }

  const adapters = createAdapters();

  if (action === "cancel") {
    return handleCancellation(ticketKey, adapters);
  }

  return handleDispatch(ticketKey, adapters);
});

async function readVerifiedBody(event: any): Promise<string> {
  const rawBody = await readRawBody(event);
  if (!rawBody) {
    throw createError({ statusCode: 400, statusMessage: "Empty body" });
  }

  const signature = getHeader(event, "x-hub-signature");
  if (!verifyJiraWebhookSignature(rawBody, signature, env.JIRA_WEBHOOK_SECRET)) {
    throw createError({ statusCode: 401, statusMessage: "Invalid signature" });
  }

  return rawBody;
}

async function handleCancellation(
  ticketKey: string,
  adapters: ReturnType<typeof createAdapters>,
) {
  const runId = await adapters.runRegistry.getRunId(ticketKey);

  if (!runId) {
    logger.info({ ticketKey }, "webhook_cancel_no_active_run");
    return { ok: true, action: "cancel", cancelled: false };
  }

  if (isClaimingSentinel(runId)) {
    await adapters.runRegistry.unregister(ticketKey);
    logger.info({ ticketKey }, "webhook_cancel_cleared_inflight_claim");
    return { ok: true, action: "cancel", cancelled: true };
  }

  const cancelled = await cancelRun(ticketKey, runId, adapters.runRegistry);
  logger.info({ ticketKey, runId, cancelled }, "webhook_cancel_result");
  return { ok: true, action: "cancel", cancelled, runId };
}

async function handleDispatch(
  ticketKey: string,
  adapters: ReturnType<typeof createAdapters>,
) {
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
}
