import { WebClient } from "@slack/web-api";
import { createLogger } from "../logger.js";
import type { MessagingAdapter } from "./messaging.js";

const logger = createLogger();

export class SlackMessagingAdapter implements MessagingAdapter {
  private client: WebClient;
  private defaultChannel: string;

  constructor(token: string, defaultChannel: string) {
    this.client = new WebClient(token);
    this.defaultChannel = defaultChannel;
  }

  async notify(_userId: string, message: string): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel: this.defaultChannel,
        text: message,
      });
      logger.info({ channel: this.defaultChannel }, "slack_notification_sent");
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : "Unknown error",
          channel: this.defaultChannel,
        },
        "slack_notification_failed",
      );
    }
  }

  async ping(_userId: string, message: string): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel: this.defaultChannel,
        text: message,
      });
      logger.info({ channel: this.defaultChannel }, "slack_ping_sent");
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : "Unknown error",
          channel: this.defaultChannel,
        },
        "slack_ping_failed",
      );
    }
  }
}
