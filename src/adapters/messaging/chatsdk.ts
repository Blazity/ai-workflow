import { Chat, ThreadImpl } from "chat";
import type { StateAdapter, Lock } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { logger } from "../../lib/logger.js";
import { formatTicketEvent, formatTicketStatus } from "./format.js";
import type { MessagingAdapter, TicketEvent } from "./types.js";
import type { ThreadStore } from "../run-registry/types.js";

export interface ChatSDKConfig {
  slackToken: string;
  channelId: string;
  botName: string;
  jiraBaseUrl: string;
  threadStore: ThreadStore;
}

/** Minimal no-op StateAdapter for outbound-only notification use. */
const noopState: StateAdapter = {
  acquireLock: async () => null,
  appendToList: async () => {},
  connect: async () => {},
  delete: async () => {},
  disconnect: async () => {},
  extendLock: async () => false,
  forceReleaseLock: async () => {},
  get: async () => null,
  getList: async () => [],
  isSubscribed: async () => false,
  releaseLock: async (_lock: Lock) => {},
  set: async () => {},
  setIfNotExists: async () => false,
  subscribe: async () => {},
  unsubscribe: async () => {},
};

/**
 * Slack error codes that mean "the parent message is gone."
 * When we see one of these on an edit or thread reply, we clear the stored
 * parent and re-anchor by posting a new top-level status message.
 */
const MISSING_PARENT_ERROR_CODES = new Set([
  "thread_not_found",
  "message_not_found",
]);

export class ChatSDKAdapter implements MessagingAdapter {
  private chat: InstanceType<typeof Chat>;
  private slackAdapter: ReturnType<typeof createSlackAdapter>;
  private channelId: string;
  private jiraBaseUrl: string;
  private threadStore: ThreadStore;

  constructor(config: ChatSDKConfig) {
    this.channelId = config.channelId;
    this.jiraBaseUrl = config.jiraBaseUrl;
    this.threadStore = config.threadStore;
    this.slackAdapter = createSlackAdapter({ botToken: config.slackToken });
    this.chat = new Chat({
      userName: config.botName,
      state: noopState,
      adapters: { slack: this.slackAdapter },
    });
  }

  /**
   * Ticket lifecycle as a single Slack thread:
   *   1. Parent (top-level) message is a live status header — edited in place
   *      on every event so the channel always shows the current state at a
   *      glance ("AWT-42 STATUS: in progress" → "...PR ready" → ...).
   *   2. Each event also lands as a detailed reply inside that thread, so the
   *      thread acts as a chronological audit log.
   *
   * Failures are logged and swallowed; workflow runs are never broken by
   * notification errors.
   */
  async notifyForTicket(
    ticketKey: string,
    event: TicketEvent,
  ): Promise<void> {
    const status = formatTicketStatus(event, ticketKey, this.jiraBaseUrl);
    const detail = formatTicketEvent(event, ticketKey, this.jiraBaseUrl);

    const parent = await this.ensureParentWithStatus(
      ticketKey,
      status,
      event.kind,
    );

    await this.postDetail(ticketKey, parent, detail, event.kind);

    logger.info(
      {
        ticketKey,
        eventKind: event.kind,
        threadParentId: parent,
        channelId: this.channelId,
      },
      "notification_sent",
    );
  }

  /**
   * Ensure a parent status message exists for this ticket and reflects the
   * current event. Returns the parent ts on success, or null if the parent
   * could not be (re)created — in which case the caller falls back to an
   * orphaned top-level detail post.
   */
  private async ensureParentWithStatus(
    ticketKey: string,
    status: string,
    eventKind: TicketEvent["kind"],
  ): Promise<string | null> {
    const stored = await this.threadStore.getParent(ticketKey).catch((err) => {
      logger.warn(
        { ticketKey, error: (err as Error).message },
        "thread_parent_lookup_failed",
      );
      return null;
    });

    if (stored) {
      try {
        await this.editTopLevel(stored, status);
        logger.info(
          {
            ticketKey,
            parent: stored,
            eventKind,
            channelId: this.channelId,
            statusLength: status.length,
          },
          "thread_parent_status_updated",
        );
        return stored;
      } catch (err) {
        if (!isMissingParentError(err)) {
          // Edit failed for a non-fatal reason (rate limit, transient).
          // Parent presumably still exists; keep using it for the thread reply.
          this.logFailure(ticketKey, eventKind, err, "parent_edit_failed");
          return stored;
        }
        // Parent is gone — clear and fall through to re-create below.
        logger.debug(
          { ticketKey, parent: stored, eventKind },
          "thread_parent_recovery_attempt",
        );
        await this.threadStore.clearParent(ticketKey).catch(() => {});
      }
    }

    try {
      const sentId = await this.postTopLevel(status);
      await this.threadStore
        .setParent(ticketKey, sentId)
        .catch((err) =>
          logger.warn(
            { ticketKey, error: (err as Error).message },
            "thread_parent_persist_failed",
          ),
        );
      if (stored) {
        logger.debug(
          { ticketKey, oldParent: stored, newParent: sentId, eventKind },
          "thread_parent_recovered",
        );
      }
      return sentId;
    } catch (err) {
      this.logFailure(ticketKey, eventKind, err, "parent_post_failed");
      return null;
    }
  }

  /**
   * Post the detailed event message. When a parent is available, posts as a
   * thread reply; otherwise falls back to an orphaned top-level message so
   * the event still leaves a record.
   */
  private async postDetail(
    ticketKey: string,
    parent: string | null,
    detail: string,
    eventKind: TicketEvent["kind"],
  ): Promise<void> {
    if (!parent) {
      await this.postTopLevel(detail).catch((err) =>
        this.logFailure(ticketKey, eventKind, err, "detail_post_failed"),
      );
      return;
    }
    try {
      await this.postReply(parent, detail);
    } catch (err) {
      if (isMissingParentError(err)) {
        // Race: parent vanished between edit/post and the thread reply.
        // Drop the mapping and fall back to top-level so the audit log
        // still gets the event; the next notification will re-anchor.
        await this.threadStore.clearParent(ticketKey).catch(() => {});
        await this.postTopLevel(detail).catch((retryErr) =>
          this.logFailure(ticketKey, eventKind, retryErr, "detail_post_failed"),
        );
        return;
      }
      this.logFailure(ticketKey, eventKind, err, "detail_post_failed");
    }
  }

  /** Top-level post to the configured channel. Returns the sent message id. */
  private async postTopLevel(text: string): Promise<string> {
    const channel = this.chat.channel(`slack:${this.channelId}`);
    const sent = await channel.post(text);
    return sent.id;
  }

  /** Edit a previously posted top-level message in place. */
  private async editTopLevel(parentTs: string, text: string): Promise<void> {
    await this.slackAdapter.editMessage(
      `slack:${this.channelId}`,
      parentTs,
      text,
    );
  }

  /** Thread reply under `parentTs`. Returns the sent message id. */
  private async postReply(parentTs: string, text: string): Promise<string> {
    const thread = new ThreadImpl({
      id: `slack:${this.channelId}:${parentTs}`,
      adapter: this.slackAdapter,
      channelId: `slack:${this.channelId}`,
      stateAdapter: noopState,
      isDM: false,
    });
    const sent = await thread.post(text);
    return sent.id;
  }

  private logFailure(
    ticketKey: string,
    eventKind: TicketEvent["kind"],
    err: unknown,
    msg: string,
  ): void {
    logger.warn(
      {
        ticketKey,
        eventKind,
        error: (err as Error).message,
        slackErrorCode: extractSlackErrorCode(err),
      },
      msg,
    );
  }
}

function isMissingParentError(err: unknown): boolean {
  const code = extractSlackErrorCode(err);
  return code != null && MISSING_PARENT_ERROR_CODES.has(code);
}

/**
 * Pull a Slack-style error code out of an unknown error. The chat package
 * surfaces Slack errors as ChatError-derived objects with a `code` string;
 * the underlying Web API error code may also live on `data.error` for raw
 * errors. We check both locations defensively.
 */
function extractSlackErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; data?: { error?: unknown } };
  // Slack SDK wraps API errors: code is the sentinel "slack_webapi_platform_error",
  // and the actual Slack API error string lives at data.error (e.g. "thread_not_found").
  if (e.data && typeof e.data.error === "string") return e.data.error;
  if (typeof e.code === "string") return e.code;
  return null;
}
