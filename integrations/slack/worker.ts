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
async function probeChannelDelivery(ctx: SlackContext): Promise<IntegrationHealthResult> {
  const client = api(ctx);
  const channel = ctx.connection.channelId;
  const postAt = Math.floor(Date.now() / 1000) + PROBE_DELAY_SECONDS;
  const scheduled = await client.call<{ scheduled_message_id?: unknown }>("chat.scheduleMessage", {
    channel,
    post_at: String(postAt),
    text: "System health delivery probe. If you are reading this, deleting it failed; it is safe to ignore.",
  });
  if (!scheduled.ok) {
    return {
      status: "down",
      message: `The bot cannot deliver to the configured channel: ${reasonOf(scheduled)}.`,
    };
  }
  const id =
    typeof scheduled.body.scheduled_message_id === "string"
      ? scheduled.body.scheduled_message_id
      : null;
  const postsOn = new Date(postAt * 1000).toISOString().slice(0, 10);
  if (!id) {
    return {
      status: "degraded",
      message: `Delivery works, but Slack did not name the probe message, so it could not be deleted and will post in the channel on ${postsOn}. Delete it from the app's scheduled messages.`,
    };
  }
  let lastFailure = "";
  for (let attempt = 0; attempt < PROBE_DELETE_ATTEMPTS; attempt += 1) {
    const deleted = await client.call("chat.deleteScheduledMessage", {
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

const definition: IntegrationRuntimeDefinition<SlackManifest> = {
  /**
   * `auth.test` is the cheapest call Slack offers, and it answers the one
   * question a token can be wrong about. The delivery probe follows it,
   * because a token that works and a channel the bot was never invited to look
   * the same until something is posted, and an admin pressing Test wants to
   * hear about both now rather than at 3am.
   */
  testConnection: async (ctx) => {
    const auth = await api(ctx).call<{ team?: unknown }>("auth.test", {});
    if (!auth.ok) {
      if (auth.error === null) throw new Error(auth.cause);
      return { ok: false, reason: `Slack refused the bot token (${auth.error}).` };
    }
    const team = typeof auth.body.team === "string" ? auth.body.team : "your workspace";
    const delivery = await probeChannelDelivery(ctx);
    if (delivery.status === "down") {
      return { ok: false, reason: delivery.message ?? "The configured channel refused a message." };
    }
    return {
      ok: true,
      message:
        delivery.status === "degraded"
          ? `Connected to ${team}. ${delivery.message}`
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
      const auth = await api(ctx).call<{ team?: unknown }>("auth.test", {});
      if (auth.ok) {
        const team = typeof auth.body.team === "string" ? auth.body.team : "the workspace";
        return { status: "live", message: `Slack accepts the bot token for ${team}.` };
      }
      return { status: "down", message: `Slack refused the bot token: ${reasonOf(auth)}.` };
    },
    channel: probeChannelDelivery,
  },

  webhook: {
    receive: (request, ctx) =>
      receiveSlashCommand(request, {
        signingSecret: ctx.connection.signingSecret,
        allowedUserIds: ctx.connection.allowedUserIds,
      }),
    deliver: (delivery, ctx) =>
      deliverSlashCommandOutcome(delivery.to, delivery.outcome, ctx.log),
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
