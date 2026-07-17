import { createHmac, timingSafeEqual } from "node:crypto";
import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import { env } from "../../../env.js";
import { getDb } from "../../db/client.js";
import { IssueTrackerNotFoundError } from "../../adapters/issue-tracker/types.js";
import { createAdapters } from "../../lib/adapters.js";
import { cancelRun } from "../../lib/cancel-run.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { logger } from "../../lib/logger.js";
import { ticketSubjectKey } from "../../lib/subject-key.js";
import { consumeTicketTransitionIntent } from "../../lib/ticket-transition-intent-store.js";
import { stopSandboxesByIds } from "../../sandbox/stop-ticket-sandboxes.js";

/**
 * Jira webhook handler — triggers the same dispatch logic as the cron poller.
 *
 * Configure in Jira (Settings → System → Webhooks) with:
 *   URL:    https://<your-domain>/webhooks/jira
 *   Secret: <JIRA_WEBHOOK_SECRET>
 *   Events: Issue updated
 *
 * Auth: X-Hub-Signature HMAC-SHA256 (Jira signs the body when a secret is set)
 *
 * The webhook fires immediately when a ticket changes,
 * eliminating the up-to-1-minute polling delay.
 */
export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  verifyWebhookAuth(event, rawBody);

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

  logger.info({ ticketKey }, "webhook_received");

  const adapters = createAdapters();
  const webhookEvent = typeof body?.webhookEvent === "string" ? body.webhookEvent : null;
  const ticketStatus = extractTicketStatus(body);
  const ticketStatusId = extractTicketStatusId(body);
  logger.info(
    {
      ticketKey,
      webhookEvent,
      payloadStatus: ticketStatus,
      payloadProjectKey: projectKey,
    },
    "webhook_payload_parsed",
  );

  if (
    ticketStatus &&
    (await consumeTicketTransitionIntent(getDb(), ticketKey, {
      id: ticketStatusId,
      name: ticketStatus,
    }))
  ) {
    logger.info(
      { ticketKey, ticketStatusId, ticketStatus },
      "webhook_consumed_workflow_transition_intent",
    );
    return {
      status: "ignored",
      reason: "workflow_transition_intent",
      ticketKey,
    };
  }

  if (!ticketStatus) {
    logger.info({ ticketKey }, "webhook_missing_payload_status_dispatching_anyway");
  }

  if (ticketStatus && !isAiColumnStatus(ticketStatus)) {
    logger.info(
      { ticketKey, payloadStatus: ticketStatus, expectedAiStatus: env.COLUMN_AI },
      "webhook_payload_status_outside_ai_column",
    );

    const liveTicketState = await getLiveTicketState(ticketKey, adapters.issueTracker);
    if (liveTicketState.inAiColumn) {
      logger.info(
        {
          ticketKey,
          payloadStatus: ticketStatus,
          liveStatus: liveTicketState.status,
          liveProjectKey: liveTicketState.projectKey,
        },
        "webhook_skip_cancel_live_ticket_in_ai_column",
      );
      logger.info(
        {
          ticketKey,
          maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
          dispatchContext: "payload_outdated_live_ticket_in_ai",
        },
        "webhook_dispatch_started",
      );
      const result = await dispatchTicket(ticketKey, adapters, env.MAX_CONCURRENT_AGENTS);
      logger.info(
        {
          ticketKey,
          started: result.started,
          reason: result.reason,
          runId: result.runId,
          dispatchContext: "payload_outdated_live_ticket_in_ai",
        },
        "webhook_dispatch_result",
      );
      return {
        status: result.started ? "dispatched" : "skipped",
        ticketKey,
        reason: result.reason,
      };
    }

    const cancelled = await cancelTrackedRun(ticketKey, adapters.runRegistry);
    if (cancelled) {
      await adapters.messaging.notifyForTicket(ticketKey, {
        kind: "canceled",
        reason: "webhook confirmed ticket is outside AI column",
      });
    }
    logger.info(
      {
        ticketKey,
        payloadStatus: ticketStatus,
        liveStatus: liveTicketState.status,
        liveProjectKey: liveTicketState.projectKey,
        cancelled,
      },
      "webhook_ticket_left_ai_column",
    );
    return {
      status: cancelled ? "cancelled" : "ignored",
      reason: "left_ai_column",
      ticketKey,
    };
  }

  logger.info(
    {
      ticketKey,
      maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      dispatchContext: "default",
    },
    "webhook_dispatch_started",
  );
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

/**
 * Verify the X-Hub-Signature HMAC sent by Jira Cloud.
 */
function verifyWebhookAuth(
  event: Parameters<typeof getHeader>[0],
  rawBody: string,
): void {
  if (!env.JIRA_WEBHOOK_SECRET) return;

  const signatureHeader = getHeader(event, "x-hub-signature");
  if (!signatureHeader) {
    throw createError({ statusCode: 401, statusMessage: "Missing X-Hub-Signature header" });
  }

  verifyHmacSignature(rawBody, signatureHeader);
}

function verifyHmacSignature(rawBody: string, signatureHeader: string): void {
  const [method, receivedSig] = signatureHeader.split("=", 2);
  if (!method || !receivedSig) {
    throw createError({ statusCode: 401, statusMessage: "Malformed X-Hub-Signature header" });
  }

  const expectedSig = createHmac(method, env.JIRA_WEBHOOK_SECRET!)
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

function extractTicketStatus(body: any): string | null {
  return body?.issue?.fields?.status?.name ?? null;
}

function extractTicketStatusId(body: any): string | null {
  return body?.issue?.fields?.status?.id ?? null;
}

function isAiColumnStatus(status: string): boolean {
  return status.trim().toLowerCase() === env.COLUMN_AI.trim().toLowerCase();
}

async function cancelTrackedRun(
  ticketKey: string,
  runRegistry: ReturnType<typeof createAdapters>["runRegistry"],
): Promise<boolean> {
  const subjectKey = ticketSubjectKey("jira", ticketKey);
  const entry = await runRegistry.get(subjectKey);
  if (!entry) return false;

  if (entry.state === "reserved") {
    const sandboxIds = await runRegistry
      .listSandboxes(entry.subjectKey, entry.ownerToken)
      .catch(() => null);
    if (sandboxIds === null) return false;
    try {
      await stopSandboxesByIds(sandboxIds);
    } catch {
      return false;
    }
    return runRegistry
      .releaseReservation(entry.subjectKey, entry.ownerToken)
      .catch(() => false);
  }

  return entry.runId ? cancelRun(ticketKey, entry.runId, runRegistry) : false;
}

async function getLiveTicketState(
  ticketKey: string,
  issueTracker: ReturnType<typeof createAdapters>["issueTracker"],
): Promise<{ inAiColumn: boolean; status: string | null; projectKey: string | null }> {
  try {
    const liveTicket = await issueTracker.fetchTicket(ticketKey);
    const status = liveTicket.trackerStatus;
    const projectKey = liveTicket.projectKey ?? extractProjectKeyFromIdentifier(liveTicket.identifier);
    const inExpectedProject =
      projectKey != null &&
      projectKey.trim().toUpperCase() === env.JIRA_PROJECT_KEY.trim().toUpperCase();
    return {
      inAiColumn: isAiColumnStatus(status) && inExpectedProject,
      status,
      projectKey,
    };
  } catch (err) {
    if (err instanceof IssueTrackerNotFoundError || getErrorCode(err) === "NOT_FOUND") {
      return { inAiColumn: false, status: null, projectKey: null };
    }
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "webhook_live_ticket_state_check_failed",
    );
    return { inAiColumn: true, status: null, projectKey: null };
  }
}

function extractProjectKeyFromIdentifier(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const dashIndex = trimmed.indexOf("-");
  if (dashIndex <= 0) return null;
  return trimmed.slice(0, dashIndex).toUpperCase();
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const maybeCode = (err as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
}
