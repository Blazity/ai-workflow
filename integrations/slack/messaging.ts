/**
 * Slack as the `messaging` capability.
 *
 * A ticket is one thread in one channel:
 *
 *   1. A top-level message is the live status header, edited in place on every
 *      event, so the channel shows the current state without opening anything.
 *   2. Every event also lands as a reply inside that thread, which is the
 *      chronological record.
 *
 * Which message a ticket is anchored on is core's row, not ours: it arrives as
 * `conversation.handle` and we hand a new one back through `remember`. The
 * handle happens to be a Slack message timestamp, which is what the rows
 * written before this package existed already hold, so nothing was migrated
 * and a thread started yesterday is still the thread today.
 *
 * Nothing here throws. A failure is reported as `{ delivered: false, reason }`
 * so a notification cannot change a run's outcome and a block that needs to
 * know whether the message arrived is told.
 *
 * `delivered` is about the event's own message and nothing else, as the port
 * defines it ("whether the message went out"). The status line is a courtesy
 * on top: when it cannot be posted or edited, for whatever reason, that is
 * logged as `slack_status_line_failed` and the delivery is still what the
 * detail message did. One rule for both halves, so a rate limit on the edit
 * and a refusal of the post cannot give two different answers for the same
 * half-updated thread.
 */
import type {
  MessageSearchOutcome,
  MessageSearchQuery,
  MessagingAdapter,
  MessagingConversation,
  MessagingDelivery,
  MessagingTicket,
  TicketEvent,
} from "@integrations/sdk";
import type { SlackApi, SlackCall } from "./api";
import { formatTicketEvent, formatTicketStatus } from "./format";
import { searchSlackChannels } from "./search";

/**
 * Slack errors that mean the message we anchored on is gone. Seeing one is
 * normal: somebody deleted the status message, or the thread aged out of a
 * retention policy. We forget the handle and post a new top-level message.
 */
const MISSING_PARENT_ERRORS = new Set(["thread_not_found", "message_not_found"]);

export interface SlackMessagingConfig {
  readonly api: SlackApi;
  readonly channelId: string;
  readonly log: {
    info(fields: Record<string, unknown>, event: string): void;
    warn(fields: Record<string, unknown>, event: string): void;
  };
}

export function slackMessaging(config: SlackMessagingConfig): MessagingAdapter {
  const { api, channelId, log } = config;

  async function post(text: string, threadTs?: string): Promise<SlackCall<{ ts?: unknown }>> {
    return api.post("chat.postMessage", {
      channel: channelId,
      text,
      unfurl_links: "false",
      unfurl_media: "false",
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  async function edit(ts: string, text: string): Promise<SlackCall<Record<string, unknown>>> {
    return api.post("chat.update", { channel: channelId, ts, text });
  }

  /**
   * Make sure the ticket has a status message and that it shows this event.
   * Returns the handle to reply under, or null when Slack would not take one,
   * in which case the detail is posted top-level so the event still leaves a
   * record. A status line that could not be updated is logged here, once.
   */
  async function anchor(
    ticket: MessagingTicket,
    conversation: MessagingConversation,
    status: string,
    kind: TicketEvent["kind"],
  ): Promise<string | null> {
    const statusLineFailed = (reason: string) =>
      log.warn({ ticketKey: ticket.key, kind, channelId, reason }, "slack_status_line_failed");

    const stored = conversation.handle;
    if (stored) {
      const updated = await edit(stored, status);
      if (updated.ok) return stored;
      if (!isMissingParent(updated)) {
        // Rate limited, or a transient refusal. The message is presumably still
        // there, so keep replying under it rather than starting a second thread.
        statusLineFailed(reasonOf(updated));
        return stored;
      }
      await conversation.forget();
    }

    const posted = await post(status);
    if (!posted.ok) {
      statusLineFailed(reasonOf(posted));
      return null;
    }
    const ts = typeof posted.body.ts === "string" ? posted.body.ts : null;
    if (!ts) {
      statusLineFailed("Slack accepted the message without naming it");
      return null;
    }
    await conversation.remember(ts);
    return ts;
  }

  async function postDetail(
    ticket: MessagingTicket,
    conversation: MessagingConversation,
    handle: string | null,
    detail: string,
  ): Promise<MessagingDelivery> {
    if (!handle) {
      const orphan = await post(detail);
      return orphan.ok ? { delivered: true } : { delivered: false, reason: reasonOf(orphan) };
    }
    const reply = await post(detail, handle);
    if (reply.ok) return { delivered: true };
    if (isMissingParent(reply)) {
      // The parent vanished between the edit and the reply. Drop it and leave
      // the record top-level; the next event re-anchors.
      await conversation.forget();
      const orphan = await post(detail);
      return orphan.ok ? { delivered: true } : { delivered: false, reason: reasonOf(orphan) };
    }
    return { delivered: false, reason: reasonOf(reply) };
  }

  return {
    async notifyForTicket(ticket, event, conversation) {
      const detail = formatTicketEvent(event, ticket);
      // A note is somebody's own message mid-run. It goes under the thread and
      // deliberately does not touch the status line: overwriting "PR ready"
      // with a note is how a channel comes to show the wrong state.
      const handle =
        event.kind === "note"
          ? conversation.handle
          : await anchor(ticket, conversation, formatTicketStatus(event, ticket), event.kind);

      const delivered = await postDetail(ticket, conversation, handle, detail);
      if (delivered.delivered) {
        log.info(
          { ticketKey: ticket.key, eventKind: event.kind, channelId },
          "slack_notification_sent",
        );
        return delivered;
      }
      log.warn(
        { ticketKey: ticket.key, eventKind: event.kind, channelId, reason: delivered.reason },
        "slack_notification_failed",
      );
      return delivered;
    },

    async searchMessages(query: MessageSearchQuery): Promise<MessageSearchOutcome> {
      return searchSlackChannels(api, query);
    },
  };
}

function isMissingParent(call: SlackCall<unknown>): boolean {
  return !call.ok && call.error !== null && MISSING_PARENT_ERRORS.has(call.error);
}

/** What a person reads about a refusal, in Slack's own words where it gave any. */
export function reasonOf(call: SlackCall<unknown>): string {
  if (call.ok) return "";
  if (call.error === null) return call.cause;
  if (call.error === "not_in_channel" || call.error === "channel_not_found") {
    return `Slack refused the channel (${call.error}); invite the bot to it`;
  }
  return `Slack refused the message (${call.error})`;
}
