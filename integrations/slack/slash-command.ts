/**
 * The `/ai-workflow` slash command: everything about it that is Slack's.
 *
 * Slack gives a slash command about three seconds. So `receive` does the least
 * it can (a signature over the raw bytes, a parse, the allowlist) and answers;
 * core then runs the command and hands the outcome to `deliver`, which posts
 * it to the one-shot `response_url` Slack sent with the request.
 *
 * Moved from `apps/worker/src/services/slack/handle-slash-command.ts`, minus
 * every decision: which runs are live, what cancel does and what reset cleared
 * are core's, and arrive as data this file renders.
 */
import type {
  IntegrationWebhookReception,
  IntegrationWebhookRequest,
  JsonValue,
  RunControlCommand,
  RunControlOutcome,
} from "@integrations/sdk";
import { parseCommand } from "./commands";
import { HELP_TEXT, renderOutcome } from "./render";
import { verifySlackSignature } from "./verify";

const RESPONSE_URL_TIMEOUT_MS = 5000;

export interface SlashCommandConfig {
  readonly signingSecret: string | undefined;
  /** Comma-separated ids, exactly as the connection field holds them. */
  readonly allowedUserIds: string | undefined;
  /**
   * Who asked for what is the audit trail of the command: a refusal and every
   * command handed to core are logged with the Slack user who typed it,
   * because `reset` carries no actor of its own and nothing else records who
   * cleared a ticket's registry state.
   */
  readonly log: { info(fields: Record<string, unknown>, event: string): void };
}

/** Only ever visible to the person who typed the command. */
function ephemeral(text: string): IntegrationWebhookReception {
  return { kind: "answered", response: { status: 200, body: { response_type: "ephemeral", text } } };
}

export async function receiveSlashCommand(
  request: IntegrationWebhookRequest,
  config: SlashCommandConfig,
): Promise<IntegrationWebhookReception> {
  if (!config.signingSecret) {
    // Not 500 and not 401: nothing is wrong with the request, this deployment
    // has not been given the secret that would let it read one.
    return {
      kind: "refused",
      status: 503,
      reason: "no Slack signing secret is configured on this deployment",
    };
  }
  const signature = request.headers["x-slack-signature"];
  const timestamp = request.headers["x-slack-request-timestamp"];
  if (!signature || !timestamp) {
    return { kind: "refused", status: 401, reason: "the Slack signature headers are missing" };
  }
  const verified = verifySlackSignature({
    rawBody: request.rawBody,
    timestamp,
    signature,
    signingSecret: config.signingSecret,
  });
  if (!verified) {
    return { kind: "refused", status: 401, reason: "the Slack signature did not verify" };
  }

  const fields = new URLSearchParams(request.rawBody);
  const text = fields.get("text") ?? "";
  const userId = fields.get("user_id") ?? "";
  const responseUrl = fields.get("response_url") ?? "";
  const command = fields.get("command") ?? "/ai-workflow";

  if (!isUserAllowed(userId, config.allowedUserIds)) {
    config.log.info({ userId, command }, "slack_command_user_not_allowed");
    return ephemeral("Not authorized.");
  }

  const parsed = parseCommand(text);
  if (parsed.kind === "help") return ephemeral(HELP_TEXT);
  if (parsed.kind === "unknown") return ephemeral(`Unknown command. ${HELP_TEXT}`);

  if (!responseUrl) {
    // Without response_url there is nowhere to post the result, so this is a
    // refusal rather than a promise nobody can keep.
    return {
      kind: "answered",
      response: {
        status: 400,
        body: {
          response_type: "ephemeral",
          text: "Slack sent no response_url with that command, so there is nowhere to send the answer.",
        },
      },
    };
  }

  config.log.info({ userId, kind: parsed.kind }, "slack_command_dispatching");
  return {
    kind: "run_control",
    command: toRunControlCommand(parsed, userId),
    response: {
      status: 200,
      body: { response_type: "ephemeral", text: `Working on \`${command} ${text}\`...` },
    },
    deliverTo: { responseUrl },
  };
}

/**
 * Post the outcome back to Slack.
 *
 * Failures are swallowed: the command already happened, and a Slack that 5xx'd
 * on the follow-up is not a reason to run it again. `in_channel` keeps today's
 * behaviour, where the answer is visible to everyone in the channel.
 */
export async function deliverSlashCommandOutcome(
  to: JsonValue,
  outcome: RunControlOutcome,
  log: { warn(fields: Record<string, unknown>, event: string): void },
): Promise<void> {
  const responseUrl =
    to && typeof to === "object" && !Array.isArray(to) && typeof to.responseUrl === "string"
      ? to.responseUrl
      : null;
  if (!responseUrl) {
    log.warn({ outcome: outcome.kind }, "slack_response_url_missing");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESPONSE_URL_TIMEOUT_MS);
  try {
    // Deliberately a bare fetch rather than `ctx.http`: response_url is a
    // one-shot Slack callback that takes no bearer token, and a retry after an
    // ambiguous failure would post the answer twice.
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text: renderOutcome(outcome) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      log.warn({ status: response.status }, "slack_response_url_post_failed");
    }
  } catch (error) {
    log.warn({ error: (error as Error).message }, "slack_response_url_post_error");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Empty means everyone, which is what it has always meant (SETUP.md). A
 * configuration nobody could read never reaches here: the integration is not
 * usable then, and the route refuses the command and says so, rather than
 * reading an unreadable list as an empty one.
 */
function isUserAllowed(userId: string, allowed: string | undefined): boolean {
  const ids = (allowed ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return ids.length === 0 || ids.includes(userId);
}

function toRunControlCommand(
  parsed: Exclude<ReturnType<typeof parseCommand>, { kind: "help" } | { kind: "unknown" }>,
  userId: string,
): RunControlCommand {
  switch (parsed.kind) {
    case "list":
      return { kind: "list" };
    case "summary":
      return { kind: "summary" };
    case "status":
      return { kind: "status", ticketKey: parsed.ticketKey };
    case "inspect":
      return { kind: "inspect", ticketKey: parsed.ticketKey };
    case "reset":
      return { kind: "reset", ticketKey: parsed.ticketKey };
    case "cancel":
      return {
        kind: "cancel",
        ticketKey: parsed.ticketKey,
        ...(userId ? { actor: userId } : {}),
      };
  }
}
