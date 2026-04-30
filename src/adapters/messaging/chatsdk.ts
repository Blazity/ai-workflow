import { Chat, ThreadImpl } from "chat";
import type { StateAdapter, Lock } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { logger } from "../../lib/logger.js";
import { formatTicketEvent } from "./format.js";
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
 * When we see one of these on a thread reply, we clear the stored parent
 * and retry top-level. List sourced from Slack's chat.postMessage docs;
 * exact codes are confirmed during smoke-testing (deliberately delete a
 * parent in a test channel).
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

  async notifyForTicket(
    ticketKey: string,
    event: TicketEvent,
  ): Promise<void> {
    const text = formatTicketEvent(event, ticketKey, this.jiraBaseUrl);
    let parent = await this.threadStore
      .getParent(ticketKey)
      .catch((err) => {
        logger.warn(
          { ticketKey, error: (err as Error).message },
          "thread_parent_lookup_failed",
        );
        return null;
      });

    let sentId: string | null = null;
    try {
      sentId = parent
        ? await this.postReply(parent, text)
        : await this.postTopLevel(text);
    } catch (err) {
      if (parent && isMissingParentError(err)) {
        logger.debug(
          { ticketKey, parent, eventKind: event.kind },
          "thread_parent_recovered",
        );
        await this.threadStore.clearParent(ticketKey).catch(() => {});
        parent = null;
        try {
          sentId = await this.postTopLevel(text);
        } catch (retryErr) {
          this.logFailure(ticketKey, event.kind, retryErr);
          return;
        }
      } else {
        this.logFailure(ticketKey, event.kind, err);
        return;
      }
    }

    if (event.kind === "started" && parent == null && sentId) {
      await this.threadStore
        .setParent(ticketKey, sentId)
        .catch((err) =>
          logger.warn(
            { ticketKey, error: (err as Error).message },
            "thread_parent_persist_failed",
          ),
        );
    }

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

  /** Top-level post to the configured channel. Returns the sent message id. */
  private async postTopLevel(text: string): Promise<string> {
    const channel = this.chat.channel(`slack:${this.channelId}`);
    const sent = await channel.post(text);
    return sent.id;
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
  ): void {
    logger.warn(
      {
        ticketKey,
        eventKind,
        error: (err as Error).message,
        slackErrorCode: extractSlackErrorCode(err),
      },
      "notification_failed",
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
