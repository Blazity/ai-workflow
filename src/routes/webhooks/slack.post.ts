import { defineEventHandler, readRawBody, getHeader, createError, type H3Event } from "h3";
import { waitUntil } from "@vercel/functions";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { cancelRun } from "../../lib/cancel-run.js";
import { logger } from "../../lib/logger.js";
import { stopTicketSandboxes } from "../../sandbox/stop-ticket-sandboxes.js";
import { parseCommand, type ParsedCommand } from "../../lib/slack/commands.js";
import { HELP_TEXT } from "../../lib/slack/format.js";
import {
  handleCancel,
  handleInspect,
  handleList,
  handleReset,
  handleStatus,
} from "../../lib/slack/handlers.js";
import { postToResponseUrl } from "../../lib/slack/respond.js";
import { verifySlackSignature } from "../../lib/slack/verify.js";

/**
 * Slack slash command webhook.
 *
 * Configure in api.slack.com → Slash Commands:
 *   Command:     /ai-workflow
 *   Request URL: https://<your-domain>/webhooks/slack
 *
 * Auth: HMAC-SHA256 over `v0:${timestamp}:${rawBody}` (Slack signs every
 * request when a Signing Secret is configured for the app).
 *
 * The 3s ack budget is critical: Slack drops requests that don't respond in
 * time. We verify, parse, schedule the real work via `event.waitUntil`, and
 * return immediately. Results are POSTed back to `response_url`.
 */
export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  verifyWebhookAuth(event, rawBody);

  const fields = parseFormBody(rawBody);
  const text = fields.get("text") ?? "";
  const userId = fields.get("user_id") ?? "";
  const responseUrl = fields.get("response_url") ?? "";
  const command = fields.get("command") ?? "/ai-workflow";

  if (!isUserAllowed(userId)) {
    logger.info({ userId, command }, "slack_command_user_not_allowed");
    return ephemeral("Not authorized.");
  }

  const parsed = parseCommand(text);

  if (parsed.kind === "help" || parsed.kind === "unknown") {
    logger.info({ userId, command, parsedKind: parsed.kind }, "slack_command_help_or_unknown");
    return ephemeral(parsed.kind === "help" ? HELP_TEXT : `Unknown command. ${HELP_TEXT}`);
  }

  if (!responseUrl) {
    // Without response_url we have no way to post the deferred result, so
    // fail loud rather than silently dropping the user's request.
    throw createError({ statusCode: 400, statusMessage: "Missing response_url" });
  }

  logger.info(
    { userId, command, parsedKind: parsed.kind },
    "slack_command_dispatching",
  );

  scheduleHandler(parsed, responseUrl);

  return ephemeral(`Working on \`${command} ${text}\`…`);
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function verifyWebhookAuth(event: H3Event, rawBody: string): void {
  const signature = getHeader(event, "x-slack-signature");
  const timestamp = getHeader(event, "x-slack-request-timestamp");
  if (!signature || !timestamp) {
    throw createError({ statusCode: 401, statusMessage: "Missing Slack signature headers" });
  }
  const ok = verifySlackSignature({
    rawBody,
    timestamp,
    signature,
    signingSecret: env.SLACK_SIGNING_SECRET,
  });
  if (!ok) {
    throw createError({ statusCode: 401, statusMessage: "Invalid Slack signature" });
  }
}

function isUserAllowed(userId: string): boolean {
  if (!env.SLACK_ALLOWED_USER_IDS) return true;
  const allow = env.SLACK_ALLOWED_USER_IDS
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length === 0) return true;
  return allow.includes(userId);
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

function parseFormBody(rawBody: string): URLSearchParams {
  return new URLSearchParams(rawBody);
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

function ephemeral(text: string) {
  return { response_type: "ephemeral" as const, text };
}

// ---------------------------------------------------------------------------
// Deferred work
// ---------------------------------------------------------------------------

function scheduleHandler(parsed: ParsedCommand, responseUrl: string): void {
  // Attach error logging before handing off — an unhandled rejection inside
  // the waitUntil-extended invocation would disappear silently otherwise.
  const promise = runHandler(parsed, responseUrl).catch((err) =>
    logger.error(
      { error: (err as Error).message, parsedKind: parsed.kind },
      "slack_handler_unhandled_error",
    ),
  );
  // @vercel/functions waitUntil is the documented Vercel-native API. It keeps
  // the serverless invocation alive until the promise resolves, even after
  // the response is sent. Outside a Vercel runtime (tests, dev), getContext()
  // returns no waitUntil and this no-ops — the promise still runs in the
  // microtask queue.
  waitUntil(promise);
}

async function runHandler(parsed: ParsedCommand, responseUrl: string): Promise<void> {
  const text = await executeCommand(parsed);
  await postToResponseUrl(responseUrl, {
    response_type: "in_channel",
    text,
  });
}

async function executeCommand(parsed: ParsedCommand): Promise<string> {
  const adapters = createAdapters();
  const { runRegistry, issueTracker } = adapters;
  switch (parsed.kind) {
    case "list":
      return handleList(runRegistry, env.JIRA_BASE_URL);
    case "status":
      return handleStatus(runRegistry, parsed.ticketKey, env.JIRA_BASE_URL);
    case "cancel":
      return handleCancel(
        runRegistry,
        parsed.ticketKey,
        cancelRun,
        stopTicketSandboxes,
        issueTracker,
        env.COLUMN_BACKLOG,
      );
    case "inspect":
      return handleInspect(runRegistry, parsed.ticketKey, env.JIRA_BASE_URL);
    case "reset":
      return handleReset(runRegistry, parsed.ticketKey);
    case "help":
    case "unknown":
      // Already handled synchronously, but exhaustive for type-narrowing.
      return HELP_TEXT;
  }
}
