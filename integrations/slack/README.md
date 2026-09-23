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

The command needs only the signing secret (the manifest's
`webhook.requires`): the answer goes to `response_url`, which takes no token,
so a deployment that registered only the command answers it, with no bot token
and no channel. Without the secret it answers 503. The card on the Integrations
screen says both: on the secret alone Slack reads Failing, because nothing can
be posted, and says the command is still answered; Connected without the
secret says the command is not.

An answer is posted for the whole channel. A command that failed on our side
is answered to the person who typed it only, with a reference such as
`AIW-DIAG-run-control-...`; the error itself is in the worker's log under that
reference, never in Slack, because the channel may be shared with another
company.

### Who may run it

`SLACK_ALLOWED_USER_IDS`, Slack user ids (`U0123...`). Empty lets everyone in
the workspace run the command. It is an operator setting, not part of the
connection: change it on the Settings page (Integrations panel) or with the MCP
`settings.set` tool, and the next command reads it. The environment variable
is still read, split on commas as it always was, while nothing is stored; a
stored value shadows it. Changing it never stops a run that is posting to
Slack, and switching the connection between environment and stored values
leaves it as it is.

The commands are `list`, `status <KEY>`, `cancel <KEY>`, `redis summary`,
`redis inspect <KEY>` and `redis reset <KEY>`. What each of them does is the
product's, not this package's: it turns the text into a run control command and
renders whatever core answers.

## What lives here

| File | What it is |
|---|---|
| `manifest.ts` | Identity, connection fields, the allowlist setting, what the webhook requires, the capability, health checks |
| `worker.ts` | Connection test, messaging adapter, health probes, the webhook |
| `api.ts` | The Slack Web API through `ctx.http` |
| `messaging.ts` | One thread per ticket: a status message edited in place, replies under it |
| `format.ts` | A ticket event as Slack mrkdwn |
| `search.ts` | Keyword search over the recent history of named channels |
| `slash-command.ts`, `commands.ts`, `verify.ts`, `render.ts` | The slash command: verify, parse, render |

The thread a ticket is anchored on is core's row, handed in as an opaque
handle. This package reads and writes no database.
