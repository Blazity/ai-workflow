import type { Chat } from "chat";
import { createLogger } from "../logger.js";
import type { MessagingAdapter } from "./messaging.js";

const logger = createLogger();

export class ChatSDKMessagingAdapter implements MessagingAdapter {
  private chat: Chat;
  private channelId: string;

  constructor(chat: Chat, platform: string, defaultChannelId: string) {
    this.chat = chat;
    this.channelId = `${platform}:${defaultChannelId}`;
  }

  async notify(_userId: string, message: string): Promise<void> {
    try {
      const channel = this.chat.channel(this.channelId);
      await channel.post(message);
      logger.info({ channelId: this.channelId }, "chatsdk_notification_sent");
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : "Unknown error",
          channelId: this.channelId,
        },
        "chatsdk_notification_failed",
      );
    }
  }

  async ping(_userId: string, message: string): Promise<void> {
    try {
      const channel = this.chat.channel(this.channelId);
      await channel.post(message);
      logger.info({ channelId: this.channelId }, "chatsdk_ping_sent");
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : "Unknown error",
          channelId: this.channelId,
        },
        "chatsdk_ping_failed",
      );
    }
  }
}
