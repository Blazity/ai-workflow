# Slack

Posts what every run is doing into one channel, answers the `/ai-workflow`
slash command, and lets a research block read what people said.

## What connecting it unlocks

- The **messaging** capability, which is what the core **Send message** block
  runs on and what every run notification (started, needs clarification, plan
  awaiting approval, PR ready, failed, cancelled) goes out through.
- Message search for the **Investigate** block, so a ticket can be triaged
  against what was said in the channels you name.
- The `/ai-workflow` slash command at `/webhooks/slack`.

Without it, runs still run: the blocks that need messaging refuse in the
editor and at dispatch, naming this integration, and the notifications that
merely report stay quiet.

## Connection

| Field | Variable | Required |
|---|---|---|
| Bot token | `CHAT_SDK_SLACK_TOKEN` | yes |
| Channel id | `CHAT_SDK_CHANNEL_ID` | yes |
| Signing secret | `SLACK_SIGNING_SECRET` | only for the slash command |
| Allowed user ids | `SLACK_ALLOWED_USER_IDS` | no, empty means everyone |

The token needs `chat:write` in that channel. Add `channels:history` only if a
workflow searches messages, and invite the bot to every channel it should read.
Slack shows the bot name configured on the app itself as the message author.

The token and the channel are required together: a token with no channel has
nowhere to post, and the card says which value is missing rather than
connecting and dropping every message.

The test button proves both halves. It calls `auth.test`, then schedules a
message sixty days out in the configured channel and deletes it, which is the
only way to tell a channel the bot may post in from one it can merely see.

System health also reports whether a webhook request reached this worker in
the last seven days, independently of the signing secret.

## The slash command

Register the request URL `https://<your-domain>/webhooks/slack` for the
`/ai-workflow` command. Slack gives it about three seconds, so the handler
verifies the signature over the raw body, acknowledges, and posts the answer
back to the `response_url` it was sent.

The commands are `list`, `status <KEY>`, `cancel <KEY>`, `redis summary`,
`redis inspect <KEY>` and `redis reset <KEY>`. What each of them does is the
product's, not this package's: it turns the text into a run control command and
renders whatever core answers.

## What lives here

| File | What it is |
|---|---|
| `manifest.ts` | Identity, connection fields, the capability, health checks |
| `worker.ts` | Connection test, messaging adapter, health probes, the webhook |
| `api.ts` | The Slack Web API through `ctx.http` |
| `messaging.ts` | One thread per ticket: a status message edited in place, replies under it |
| `format.ts` | A ticket event as Slack mrkdwn |
| `search.ts` | Keyword search over the recent history of named channels |
| `slash-command.ts`, `commands.ts`, `verify.ts`, `render.ts` | The slash command: verify, parse, render |

The thread a ticket is anchored on is core's row, handed in as an opaque
handle. This package reads and writes no database.
