import { createHmac, timingSafeEqual } from "node:crypto";
import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { logger } from "../../lib/logger.js";

/**
 * Jira webhook handler — triggers the same dispatch logic as the cron poller.
 *
 * Configure in Jira (Settings → System → Webhooks) with:
 *   URL:    https://<your-domain>/webhooks/jira
 *   Secret: <JIRA_WEBHOOK_SECRET>
 *   Events: Issue updated
 *
 * Jira signs the payload with HMAC-SHA256 and sends it in the
 * X-Hub-Signature header (format: "sha256=<hex>").
 *
 * The webhook fires immediately when a ticket is moved to the AI column,
 * eliminating the up-to-1-minute polling delay.
 */
export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event, "utf8");

  verifyWebhookSignature(
    rawBody ?? "",
    getHeader(event, "x-hub-signature"),
  );

  const body = rawBody ? JSON.parse(rawBody) : {};

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
// Auth — HMAC-SHA256 signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the X-Hub-Signature header sent by Jira Cloud.
 *
 * Jira computes HMAC-SHA256 of the raw request body using the webhook
 * secret and sends it as "sha256=<hex>" in the X-Hub-Signature header.
 *
 * When JIRA_WEBHOOK_SECRET is not set, verification is skipped (open access).
 */
function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): void {
  if (!env.JIRA_WEBHOOK_SECRET) return;

  if (!signatureHeader) {
    throw createError({ statusCode: 401, statusMessage: "Missing X-Hub-Signature header" });
  }

  const [method, receivedSig] = signatureHeader.split("=", 2);
  if (!method || !receivedSig) {
    throw createError({ statusCode: 401, statusMessage: "Malformed X-Hub-Signature header" });
  }

  const expectedSig = createHmac(method, env.JIRA_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");

  const a = Buffer.from(receivedSig, "hex");
  const b = Buffer.from(expectedSig, "hex");

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw createError({ statusCode: 401, statusMessage: "Invalid webhook signature" });
  }
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
