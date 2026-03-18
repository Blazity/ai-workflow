import type { MessagingAdapter } from "./messaging.js";

export class NoopMessagingAdapter implements MessagingAdapter {
  async notify(): Promise<void> {}
  async ping(): Promise<void> {}
}
