/**
 * The worker half of the Slack integration: the connection test, the messaging
 * capability, the two health probes and the slash command.
 *
 * No step directive belongs here. Core runs everything through its own steps
 * and routes, which is what keeps a moved or renamed integration from
 * stranding a suspended run.
 */
import {
  defineIntegrationRuntime,
  type IntegrationContext,
  type IntegrationHealthResult,
  type IntegrationRuntimeDefinition,
} from "@integrations/sdk";
import { slackApi, type SlackApi } from "./api";
import { manifest } from "./manifest";
import { reasonOf, slackMessaging } from "./messaging";
import { deliverSlashCommandOutcome, receiveSlashCommand } from "./slash-command";

type SlackManifest = typeof manifest;
type SlackContext = IntegrationContext<SlackManifest>;

/**
 * Sixty days: far enough that a leaked probe message is obvious in the
 * scheduled queue rather than arriving in somebody's channel next week, and
 * well inside Slack's 120-day scheduling ceiling.
 */
const PROBE_DELAY_SECONDS = 60 * 24 * 60 * 60;
/** A delete that failed once is usually a rate limit; a message nobody deleted posts. */
const PROBE_DELETE_ATTEMPTS = 3;

function api(ctx: SlackContext): SlackApi {
  return slackApi(ctx.http, ctx.connection.botToken);
}

/**
 * What the delivery probe found: Slack refused to schedule into the channel,
 * Slack gave no verdict, or delivery works (and how cleanly it was cleaned
 * up). The connection test and the health row read the same probe and say
 * different things about the first two.
 */
type DeliveryProbe =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "no_verdict"; readonly cause: string }
  | { readonly kind: "delivers"; readonly health: IntegrationHealthResult };

/**
 * Prove the bot can deliver to the configured channel the way a real
 * notification does: schedule a message far in the future, then delete it
 * before it can ever post. `conversations.info` asked the wrong question,
 * needing read scopes and channel visibility that posting never requires, so
 * a Slack Connect channel read as unavailable while messages flowed fine.
 *
 * The delete is the part that matters to somebody else's channel, so it is
 * retried, and a cleanup that still could not be done is said out loud with
 * the date the message would arrive. Reporting "delivery verified" over a
 * message we left in the queue is how a probe becomes the thing it tests for.
 */
async function probeChannelDelivery(ctx: SlackContext): Promise<DeliveryProbe> {
  const client = api(ctx);
  const channel = ctx.connection.channelId;
  const postAt = Math.floor(Date.now() / 1000) + PROBE_DELAY_SECONDS;
  const scheduled = await client.post<{ scheduled_message_id?: unknown }>("chat.scheduleMessage", {
    channel,
    post_at: String(postAt),
    text: "System health delivery probe. If you are reading this, deleting it failed; it is safe to ignore.",
  });
  if (!scheduled.ok) {
    // A token no request can carry is a reason the bot cannot deliver, not
    // Slack being silent.
    return scheduled.error === null && scheduled.kind !== "malformed"
      ? { kind: "no_verdict", cause: scheduled.cause }
      : { kind: "refused", reason: reasonOf(scheduled) };
  }
  return { kind: "delivers", health: await deleteProbeMessage(client, channel, scheduled.body, postAt) };
}

async function deleteProbeMessage(
  client: SlackApi,
  channel: string,
  scheduled: { scheduled_message_id?: unknown },
  postAt: number,
): Promise<IntegrationHealthResult> {
  const id =
    typeof scheduled.scheduled_message_id === "string" ? scheduled.scheduled_message_id : null;
  const postsOn = new Date(postAt * 1000).toISOString().slice(0, 10);
  if (!id) {
    return {
      status: "degraded",
      message: `Delivery works, but Slack did not name the probe message, so it could not be deleted and will post in the channel on ${postsOn}. Delete it from the app's scheduled messages.`,
    };
  }
  let lastFailure = "";
  for (let attempt = 0; attempt < PROBE_DELETE_ATTEMPTS; attempt += 1) {
    const deleted = await client.post("chat.deleteScheduledMessage", {
      channel,
      scheduled_message_id: id,
    });
    if (deleted.ok) {
      return {
        status: "live",
        message:
          "Delivery verified: a probe message was scheduled in the channel and deleted before sending.",
      };
    }
    // Already gone counts as cleaned up: two overlapping scans race here.
    if (deleted.error === "invalid_scheduled_message_id") {
      return {
        status: "live",
        message:
          "Delivery verified: a probe message was scheduled in the channel and deleted before sending.",
      };
    }
    lastFailure = reasonOf(deleted);
  }
  return {
    status: "degraded",
    message: `Delivery works, but the probe message could not be deleted: ${lastFailure}. It will post in the channel on ${postsOn}; delete it from the app's scheduled messages, or give the bot chat:write to remove it.`,
  };
}

/** A cause as the end of a sentence: one full stop, whether or not it came
 *  with its own. */
function sentence(cause: string): string {
  return /[.!?]$/u.test(cause) ? cause : `${cause}.`;
}

const definition: IntegrationRuntimeDefinition<SlackManifest> = {
  /**
   * `auth.test` is the cheapest call Slack offers, and it answers the one
   * question a token can be wrong about. The delivery probe follows it,
   * because a token that works and a channel the bot was never invited to look
   * the same until something is posted, and an admin pressing Test wants to
   * hear about both now rather than at 3am.
   */
  testConnection: async (ctx) => {
    // Slack's refusals are a verdict on the token or the channel; no verdict
    // (unreachable, rate limited, failing on its side) throws, so an outage
    // while an admin presses Test is not recorded as a bad token.
    const auth = await api(ctx).post<{ team?: unknown }>("auth.test", {});
    if (!auth.ok) {
      // A token no request can carry is a verdict about that value, and says
      // which field; Slack never saw it.
      if (auth.error === null && auth.kind === "malformed") {
        return { ok: false, reason: auth.cause, malformed: true };
      }
      if (auth.error === null) throw new Error(`Slack did not answer: ${sentence(auth.cause)}`);
      return { ok: false, reason: `Slack refused the bot token (${auth.error}).` };
    }
    const team = typeof auth.body.team === "string" ? auth.body.team : "your workspace";
    const delivery = await probeChannelDelivery(ctx);
    if (delivery.kind === "no_verdict") {
      throw new Error(`Slack did not answer the delivery check: ${sentence(delivery.cause)}`);
    }
    if (delivery.kind === "refused") {
      return {
        ok: false,
        reason: `The bot cannot deliver to the configured channel: ${sentence(delivery.reason)}`,
      };
    }
    return {
      ok: true,
      message:
        delivery.health.status === "degraded"
          ? `Connected to ${team}. ${delivery.health.message}`
          : `Connected to ${team}, and the configured channel accepts messages.`,
    };
  },

  capabilities: {
    messaging: (ctx) =>
      slackMessaging({
        api: api(ctx),
        channelId: ctx.connection.channelId,
        log: ctx.log,
      }),
  },

  blocks: {},

  health: {
    "bot-auth": async (ctx) => {
      const auth = await api(ctx).post<{ team?: unknown }>("auth.test", {});
      if (auth.ok) {
        const team = typeof auth.body.team === "string" ? auth.body.team : "the workspace";
        return { status: "live", message: `Slack accepts the bot token for ${team}.` };
      }
      if (auth.error === null && auth.kind === "malformed") return { status: "down", message: auth.cause };
      return auth.error === null
        ? {
            status: "down",
            message: `Slack did not answer, so the token could not be checked: ${sentence(auth.cause)}`,
          }
        : { status: "down", message: `Slack refused the bot token (${auth.error}).` };
    },
    channel: async (ctx) => {
      const delivery = await probeChannelDelivery(ctx);
      switch (delivery.kind) {
        case "delivers":
          return delivery.health;
        case "refused":
          return {
            status: "down",
            message: `The bot cannot deliver to the configured channel: ${sentence(delivery.reason)}`,
          };
        case "no_verdict":
          return {
            status: "down",
            message: `Slack did not answer, so delivery could not be checked: ${sentence(delivery.cause)}`,
          };
      }
    },
  },

  webhook: {
    receive: (request, ctx) =>
      receiveSlashCommand(request, {
        signingSecret: ctx.connection.signingSecret,
        allowedUserIds: ctx.connection.allowedUserIds,
        log: ctx.log,
      }),
    deliver: (delivery, ctx) =>
      deliverSlashCommandOutcome(delivery.to, delivery.outcome, ctx.log),
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
