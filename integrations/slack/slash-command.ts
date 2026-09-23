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
  /** Always there: core serves this webhook only while the secret has a value. */
  readonly signingSecret: string;
  /**
   * Who may run a command, from the operator's `allowedUserIds` setting as it
   * stands when the command arrives. Empty means everyone.
   */
  readonly allowedUserIds: readonly string[];
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
    // What the person typed travels with the callback, so a failure can say
    // which command did not complete: core hands back a reference, not a
    // sentence, and the sentence is written here.
    deliverTo: { responseUrl, asked: `${command} ${text}`.trim() },
  };
}

/**
 * Post the outcome back to Slack.
 *
 * An answer is `in_channel`, visible to everyone there, as it always was: a
 * cancel is news for the people watching the ticket. A failure is `ephemeral`,
 * shown only to the person who typed the command, who is the one waiting for
 * it (the "Working on ..." they read was theirs alone too), and the channel
 * learns nothing from a command that did not happen. Slack's guidance says
 * the same of an error reply.
 *
 * Failures to post are swallowed: the command already happened, and a Slack
 * that 5xx'd on the follow-up is not a reason to run it again.
 */
export async function deliverSlashCommandOutcome(
  to: JsonValue,
  outcome: RunControlOutcome,
  log: { warn(fields: Record<string, unknown>, event: string): void },
): Promise<void> {
  const target: Readonly<Record<string, JsonValue | undefined>> =
    to && typeof to === "object" && !Array.isArray(to) ? to : {};
  const responseUrl = typeof target.responseUrl === "string" ? target.responseUrl : null;
  const asked = typeof target.asked === "string" ? target.asked : undefined;
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
      body: JSON.stringify({
        response_type: outcome.kind === "failed" ? "ephemeral" : "in_channel",
        text: renderOutcome(outcome, asked),
      }),
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
 * setting nobody could read never reaches here: core refuses the request with
 * 503 rather than reading an unreadable list as an empty one. An entry is
 * compared trimmed and a blank one counts for nothing, as when the list was
 * split out of the variable, whichever surface stored it.
 */
function isUserAllowed(userId: string, allowed: readonly string[]): boolean {
  const ids = allowed.map((id) => id.trim()).filter((id) => id !== "");
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
