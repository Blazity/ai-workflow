import { createLogger } from "../logger.js";
import type { MessagingAdapter } from "./messaging.js";

const logger = createLogger();

export class ConsoleMessagingAdapter implements MessagingAdapter {
  async notify(_userId: string, message: string): Promise<void> {
    logger.info({ message }, "notification_sent");
  }

  async ping(_userId: string, message: string): Promise<void> {
    logger.info({ message }, "ping_sent");
  }
}
