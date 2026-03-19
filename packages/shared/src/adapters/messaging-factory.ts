import { Chat } from "chat";
import type { StateAdapter } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createLogger } from "../logger.js";
import { ChatSDKMessagingAdapter } from "./chatsdk-messaging.js";
import { NoopMessagingAdapter } from "./noop-messaging.js";
import type { MessagingAdapter } from "./messaging.js";

const logger = createLogger();

export function createMessagingAdapter(
  kind: string,
  slackBotToken: string | undefined,
  slackDefaultChannel: string | undefined,
): MessagingAdapter {
  if (kind === "slack") {
    if (!slackBotToken) {
      logger.warn("SLACK_BOT_TOKEN not set — notifications disabled");
      return new NoopMessagingAdapter();
    }
    if (!slackDefaultChannel) {
      logger.warn("SLACK_DEFAULT_CHANNEL not set — notifications disabled");
      return new NoopMessagingAdapter();
    }

    const chat = new Chat({
      userName: "blazebot",
      adapters: {
        slack: createSlackAdapter({ botToken: slackBotToken }),
      },
      // State is required by ChatConfig type but only used for subscriptions/locking.
      // channel.post() delegates directly to adapter.postMessage() without touching state.
      state: {} as StateAdapter,
    });

    return new ChatSDKMessagingAdapter(chat, "slack", slackDefaultChannel);
  }

  return new NoopMessagingAdapter();
}
