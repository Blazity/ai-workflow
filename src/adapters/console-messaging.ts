import type { MessagingAdapter } from "./messaging.js";

export class ConsoleMessagingAdapter implements MessagingAdapter {
  async notify(_userId: string, message: string): Promise<void> {
    console.log(`[notification] ${message}`);
  }

  async ping(_userId: string, message: string): Promise<void> {
    console.log(`[ping] ${message}`);
  }
}
