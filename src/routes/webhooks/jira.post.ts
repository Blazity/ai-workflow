import { defineEventHandler, readBody, getHeader, createError } from "h3";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { logger } from "../../lib/logger.js";

/**
 * Jira webhook handler — triggers the same dispatch logic as the cron poller.
 *
 * Configure in Jira (Settings → System → Webhooks) with:
 *   URL:     https://<your-domain>/webhooks/jira
 *   Headers: Authorization: Bearer <JIRA_WEBHOOK_SECRET>
 *   Events:  Issue updated
 *
 * The webhook fires immediately when a ticket is moved to the AI column,
 * eliminating the up-to-1-minute polling delay.
 */
export default defineEventHandler(async (event) => {
  verifyWebhookAuth(event);

  const body = await readBody(event);

  const ticketKey = extractTicketKey(body);
  if (!ticketKey) {
    logger.debug({ webhookEvent: body?.webhookEvent }, "webhook_ignored_no_ticket_key");
    return { status: "ignored", reason: "no_ticket_key" };
  }

  const projectKey = extractProjectKey(body);
  if (projectKey && projectKey.toUpperCase() !== env.JIRA_PROJECT_KEY.toUpperCase()) {
    logger.debug(
      { ticketKey, projectKey, expectedProject: env.JIRA_PROJECT_KEY },
      "webhook_ignored_wrong_project",
    );
    return { status: "ignored", reason: "wrong_project", ticketKey };
  }

  const targetColumn = extractDestinationStatus(body);
  if (!targetColumn || targetColumn.toLowerCase() !== env.COLUMN_AI.toLowerCase()) {
    logger.debug(
      { ticketKey, targetColumn, expectedColumn: env.COLUMN_AI },
      "webhook_ignored_not_ai_column",
    );
    return { status: "ignored", reason: "not_ai_column", ticketKey };
  }

  logger.info({ ticketKey }, "webhook_received_ai_column_transition");

  const adapters = createAdapters();
  const result = await dispatchTicket(ticketKey, adapters, env.MAX_CONCURRENT_AGENTS);

  logger.info(
    { ticketKey, started: result.started, reason: result.reason, runId: result.runId },
    "webhook_dispatch_result",
  );

  return {
    status: result.started ? "dispatched" : "skipped",
    ticketKey,
    reason: result.reason,
  };
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function verifyWebhookAuth(event: Parameters<typeof getHeader>[0]): void {
  if (!env.JIRA_WEBHOOK_SECRET) return;

  const headerSecret = getHeader(event, "authorization")?.replace(/^Bearer\s+/i, "");
  if (headerSecret === env.JIRA_WEBHOOK_SECRET) return;

  throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
}

// ---------------------------------------------------------------------------
// Payload parsing — Jira Cloud webhook payloads
// ---------------------------------------------------------------------------

/**
 * Extract the issue key from a Jira webhook payload.
 * Jira sends `issue.key` (e.g. "AWT-42") in most webhook event types.
 */
function extractTicketKey(body: any): string | null {
  return body?.issue?.key ?? null;
}

/**
 * Extract the project key from a Jira webhook payload.
 * Available at `issue.fields.project.key` (e.g. "AWT").
 */
function extractProjectKey(body: any): string | null {
  return body?.issue?.fields?.project?.key ?? null;
}

/**
 * Extract the destination status after a transition.
 *
 * Jira "issue_updated" webhooks include a `changelog.items` array.
 * When the status field changes, one item will have `field === "status"`
 * with `toString` being the new status name.
 */
function extractDestinationStatus(body: any): string | null {
  const items: any[] = body?.changelog?.items ?? [];
  const statusChange = items.find((item: any) => item.field === "status");
  return statusChange?.toString ?? null;
}
