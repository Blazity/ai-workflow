import { createLogger } from "../logger.js";
import { NoopMessagingAdapter } from "./noop-messaging.js";
import { SlackMessagingAdapter } from "./slack-messaging.js";
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
    return new SlackMessagingAdapter(slackBotToken, slackDefaultChannel);
  }

  return new NoopMessagingAdapter();
}
