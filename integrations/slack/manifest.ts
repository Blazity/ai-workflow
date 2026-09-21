/**
 * Slack: where a run says what it is doing, where a person answers back, and
 * what a research block can read.
 *
 * Plain data, imported only from @integrations/sdk. The four variables are the
 * ones this product has always read, with the meaning they have always had, so
 * a deployment configured before this package existed keeps working with
 * nothing to do.
 *
 * The channel is a connection field bound to its variable rather than an
 * operator setting, because that is where it already lives and moving it would
 * be the data migration this whole plan promises not to make. An admin who
 * would rather edit it in the dashboard switches the source in one action.
 */
import { defineIntegration } from "@integrations/sdk";

export const manifest = defineIntegration({
  id: "slack",
  name: "Slack",
  description:
    "Posts each run's progress in a channel thread, answers the /ai-workflow command, and lets a research block read what people said.",
  docsUrl: "https://api.slack.com/apps",
  connection: {
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        description:
          "The bot token of your Slack app, starting xoxb-. It needs chat:write in the channel below, and channels:history to let a research block read messages.",
        env: "CHAT_SDK_SLACK_TOKEN",
        secret: true,
        // The token is the only thing that says which workspace this is. Without
        // this flag a token swapped for another workspace's would read as a
        // rotation and a run in flight would post into the wrong company's
        // channel; with it, the swap stops the run instead.
        identity: true,
      },
      {
        key: "channelId",
        label: "Channel id",
        description:
          "Where run notifications go, as an id such as C0123456789. A token with no channel has nowhere to post, so both are required.",
        env: "CHAT_SDK_CHANNEL_ID",
        secret: false,
      },
      {
        key: "signingSecret",
        label: "Signing secret",
        description:
          "From the app's Basic Information page. Needed only to accept the /ai-workflow slash command; without it that command is refused and everything else works.",
        env: "SLACK_SIGNING_SECRET",
        secret: true,
        optional: true,
      },
      {
        key: "allowedUserIds",
        label: "Allowed user ids",
        description:
          "Comma-separated Slack user ids that may run the slash command. Leave empty to allow everyone in the workspace.",
        env: "SLACK_ALLOWED_USER_IDS",
        secret: false,
        optional: true,
      },
    ],
  },
  capabilities: ["messaging"],
  blocks: [],
  pages: [],
  health: [
    {
      id: "bot-auth",
      label: "Bot authentication",
      description: "Slack accepts the bot token and names the workspace it belongs to.",
      critical: true,
    },
    {
      id: "channel",
      label: "Configured channel delivery",
      description:
        "The bot can deliver to the configured channel, proved the way a real notification would.",
      critical: true,
    },
  ],
});
