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
 *
 * Who may use the slash command is not a connection value at all: it is an
 * operator setting (`settings`), stored with every other setting, read when a
 * command arrives and never pinned by a run. As a connection field it moved a
 * run's pin when somebody added a colleague, stopping runs that were posting,
 * and it vanished when the connection's source was switched to stored values.
 * `SLACK_ALLOWED_USER_IDS` is still read while nothing is stored, exactly as
 * before.
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
    ],
  },
  settings: [
    {
      key: "allowedUserIds",
      description:
        "User ids (U0123...) that may run the /ai-workflow slash command. Empty lets everyone in the workspace run it.",
      type: "string-list",
      default: [],
      env: "SLACK_ALLOWED_USER_IDS",
    },
  ],
  capabilities: ["messaging"],
  blocks: [],
  pages: [],
  // The slash command verifies with the signing secret and answers through the
  // one-shot response_url Slack sends with it, so it needs neither the bot
  // token nor the channel: a deployment that registered only the command
  // answers it.
  webhook: { requires: ["signingSecret"], label: "/ai-workflow slash command" },
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
