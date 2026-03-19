import type { MessagingAdapter } from "./messaging.js";

export class NoopMessagingAdapter implements MessagingAdapter {
  async notify(_userId: string, _message: string): Promise<void> {}
  async ping(_userId: string, _message: string): Promise<void> {}
}
