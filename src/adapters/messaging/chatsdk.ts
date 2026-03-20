import { Chat } from "chat";
import type { StateAdapter, Lock } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { logger } from "../../lib/logger.js";
import type { MessagingAdapter } from "./types.js";

export interface ChatSDKConfig {
  slackToken: string;
  channelId: string;
  botName: string;
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

export class ChatSDKAdapter implements MessagingAdapter {
  private chat: InstanceType<typeof Chat>;
  private channelId: string;

  constructor(config: ChatSDKConfig) {
    this.channelId = config.channelId;
    this.chat = new Chat({
      userName: config.botName,
      state: noopState,
      adapters: {
        slack: createSlackAdapter({ botToken: config.slackToken }),
      },
    });
  }

  async notify(message: string): Promise<void> {
    try {
      const channel = this.chat.channel(`slack:${this.channelId}`);
      await channel.post(message);
    } catch (err) {
      logger.warn(
        { error: (err as Error).message },
        "notification_failed",
      );
    }
  }
}
