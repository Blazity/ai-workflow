/**
 * The slash command, decided end to end.
 *
 * The route above holds the raw bytes, the two headers Slack signs with, and
 * the translation of a refusal into an HTTP status. Everything the command
 * means, the signature check on those exact bytes, the user allowlist, the
 * parse, the deferred handler and the acknowledgement Slack has three seconds
 * to receive, lives here.
 */
import { waitUntil } from "@vercel/functions";

import { logger } from "../../infra/logger.js";
import { cancelRun } from "../run-lifecycle/index.js";
import {
  issueTrackerBaseUrl,
  loadSettingsSnapshot,
  slackAllowedUserIds,
  slackSigningSecret,
  ticketBoardSettings,
} from "../settings/index.js";
import { observeProviderWebhook } from "../system/index.js";
import { TriggerHttpError } from "../../infra/trigger-http-error.js";
import { createAdapters } from "../../engine/support/adapters.js";
import { parseCommand, type ParsedCommand } from "./commands.js";
import { HELP_TEXT } from "./format.js";
import {
  handleCancel,
  handleInspect,
  handleList,
  handleReset,
  handleStatus,
  handleSummary,
} from "./handlers.js";
import { postToResponseUrl } from "./respond.js";
import { verifySlackSignature } from "./verify.js";

/** One slash command invocation, as the transport captured it. */
export type SlackSlashCommandRequest = {
  /** The exact bytes the signature covers, before anything parses them. */
  rawBody: string;
  signature?: string;
  timestamp?: string;
};

export type SlackSlashCommandResponse = {
  response_type: "ephemeral";
  text: string;
};

export async function handleSlackSlashCommand(
  request: SlackSlashCommandRequest,
): Promise<SlackSlashCommandResponse> {
  try {
    verifySlashCommandAuth(request);
  } catch (error) {
    observeProviderWebhook(
      "slack",
      "rejected",
      slackSigningSecret() ? "invalid_signature" : "secret_not_configured",
    );
    throw error;
  }
  try {
    const result = await handleVerifiedSlashCommand(request.rawBody);
    observeProviderWebhook("slack", "accepted", "request_succeeded");
    return result;
  } catch (error) {
    observeProviderWebhook("slack", "rejected", "handler_failed");
    throw error;
  }
}

async function handleVerifiedSlashCommand(
  rawBody: string,
): Promise<SlackSlashCommandResponse> {
  const fields = new URLSearchParams(rawBody);
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
    throw new TriggerHttpError(400, "Missing response_url");
  }

  logger.info(
    { userId, command, parsedKind: parsed.kind },
    "slack_command_dispatching",
  );

  scheduleHandler(parsed, responseUrl, userId);

  return ephemeral(`Working on \`${command} ${text}\`…`);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function verifySlashCommandAuth(request: SlackSlashCommandRequest): void {
  const signingSecret = slackSigningSecret();
  if (!signingSecret) {
    throw new TriggerHttpError(503, "Slack integration not configured");
  }
  if (!request.signature || !request.timestamp) {
    throw new TriggerHttpError(401, "Missing Slack signature headers");
  }
  const ok = verifySlackSignature({
    rawBody: request.rawBody,
    timestamp: request.timestamp,
    signature: request.signature,
    signingSecret,
  });
  if (!ok) {
    throw new TriggerHttpError(401, "Invalid Slack signature");
  }
}

function isUserAllowed(userId: string): boolean {
  const allow = slackAllowedUserIds();
  if (allow.length === 0) return true;
  return allow.includes(userId);
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

function ephemeral(text: string): SlackSlashCommandResponse {
  return { response_type: "ephemeral" as const, text };
}

// ---------------------------------------------------------------------------
// Deferred work
// ---------------------------------------------------------------------------

function scheduleHandler(parsed: ParsedCommand, responseUrl: string, userId: string): void {
  // Attach error logging before handing off: an unhandled rejection inside
  // the waitUntil-extended invocation would disappear silently otherwise.
  const promise = runHandler(parsed, responseUrl, userId).catch((err) =>
    logger.error(
      { error: (err as Error).message, parsedKind: parsed.kind },
      "slack_handler_unhandled_error",
    ),
  );
  // @vercel/functions waitUntil is the documented Vercel-native API. It keeps
  // the serverless invocation alive until the promise resolves, even after
  // the response is sent. Outside a Vercel runtime (tests, dev), getContext()
  // returns no waitUntil and this no-ops, so the promise still runs in the
  // microtask queue.
  waitUntil(promise);
}

async function runHandler(parsed: ParsedCommand, responseUrl: string, userId: string): Promise<void> {
  const text = await executeCommand(parsed, userId);
  await postToResponseUrl(responseUrl, {
    response_type: "in_channel",
    text,
  });
}

async function executeCommand(parsed: ParsedCommand, userId?: string): Promise<string> {
  const adapters = createAdapters();
  const { runRegistry, issueTracker } = adapters;
  // The deferred handler is its own entry point: it runs after the three-second
  // acknowledgement, so it reads the deployment's settings here rather than on
  // the path Slack is timing.
  const board = ticketBoardSettings(await loadSettingsSnapshot());
  const trackerBaseUrl = issueTrackerBaseUrl();
  const backlogMoveTarget = board.backlogTransitionId
    ? { name: board.backlogColumn, transitionId: board.backlogTransitionId }
    : board.backlogColumn;
  switch (parsed.kind) {
    case "list":
      return handleList(runRegistry, trackerBaseUrl);
    case "status":
      return handleStatus(runRegistry, parsed.ticketKey, trackerBaseUrl);
    case "cancel":
      return handleCancel(
        runRegistry,
        parsed.ticketKey,
        cancelRun,
        issueTracker,
        backlogMoveTarget,
        `Cancelled via Slack /ai-workflow cancel${userId ? ` by ${userId}` : ""}`,
      );
    case "inspect":
      return handleInspect(runRegistry, parsed.ticketKey, trackerBaseUrl);
    case "summary":
      return handleSummary(runRegistry, trackerBaseUrl);
    case "reset":
      return handleReset(runRegistry, parsed.ticketKey);
    case "help":
    case "unknown":
      // Already handled synchronously, but exhaustive for type-narrowing.
      return HELP_TEXT;
  }
}
