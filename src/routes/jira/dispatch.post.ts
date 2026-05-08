import { timingSafeEqual } from "node:crypto";
import { defineEventHandler, readBody, getHeader, createError } from "h3";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { logger } from "../../lib/logger.js";

/**
 * Forge bridge endpoint — receives forwarded Jira issue-updated events from
 * the ai-workflow-jira-app Forge app. Authenticated by a shared secret in
 * the X-Forge-Secret header instead of HMAC over the body (Forge handles the
 * Jira-side auth via api.asApp(), so we only need to verify that the caller
 * is our own Forge install).
 *
 * Coexists with /webhooks/jira: either path can drive dispatch during the
 * cutover. After Forge is confirmed working, deregister the manual webhook
 * in Jira admin UI.
 */
export default defineEventHandler(async (event) => {
  if (!env.FORGE_SHARED_SECRET) {
    throw createError({ statusCode: 503, statusMessage: "Forge bridge disabled" });
  }

  const provided = getHeader(event, "x-forge-secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(env.FORGE_SHARED_SECRET);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw createError({ statusCode: 401, statusMessage: "Invalid forge secret" });
  }

  const body = await readBody(event);
  const ticketKey = typeof body?.issueKey === "string" ? body.issueKey.trim() : "";
  if (!ticketKey) {
    return { status: "ignored", reason: "no_ticket_key" };
  }

  const expectedPrefix = `${env.JIRA_PROJECT_KEY.trim().toUpperCase()}-`;
  if (!ticketKey.toUpperCase().startsWith(expectedPrefix)) {
    logger.debug(
      { ticketKey, expectedProject: env.JIRA_PROJECT_KEY },
      "forge_dispatch_ignored_wrong_project",
    );
    return { status: "ignored", reason: "wrong_project", ticketKey };
  }

  logger.info(
    {
      ticketKey,
      source: typeof body?.source === "string" ? body.source : "forge",
      cloudId: typeof body?.cloudId === "string" ? body.cloudId : null,
      payloadStatus: typeof body?.payloadStatus === "string" ? body.payloadStatus : null,
    },
    "forge_dispatch_received",
  );

  const adapters = createAdapters();
  const result = await dispatchTicket(ticketKey, adapters, env.MAX_CONCURRENT_AGENTS);
  logger.info(
    { ticketKey, started: result.started, reason: result.reason, runId: result.runId },
    "forge_dispatch_result",
  );
  return {
    status: result.started ? "dispatched" : "skipped",
    ticketKey,
    reason: result.reason,
  };
});
