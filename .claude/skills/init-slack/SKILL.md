---
name: init-slack
description: Configure or rotate the Slack bot integration for Blazebot notifications — bot token, channel ID, bot name. Use for "set up slack bot", "rotate slack token", "change slack channel", "configure blazebot slack".
---

# Initialize Slack

Configures the Slack bot Blazebot uses to post status updates (run started, PR opened, run failed, etc.) to a single channel.

> If you want full project setup (Jira + VCS + Agent + Slack + Upstash + deploy), invoke `init-env` instead. This skill only handles Slack.

## Precondition

`.vercel/project.json` must exist. If missing:

```
ERROR: no Vercel project linked. Run `vercel link` first, or invoke `init-env`
for the full first-time setup.
```

Halt.

## Step 1 — Bot app and token

If a Blazebot Slack app already exists in the workspace, the user just needs the bot token and a channel ID — skip to step 2.

Otherwise, walk the user through `references/bot-app-setup.md` to create the Slack app with the right scopes.

## Step 2 — Collect values

Ask:

- `CHAT_SDK_SLACK_TOKEN` — bot token, starts with `xoxb-`
- `CHAT_SDK_CHANNEL_ID` — channel ID like `C0123456789` (not `#channel-name`)
- `CHAT_SDK_BOT_NAME` — defaults to `blazebot`; only ask if the user wants to override
- `SLACK_SIGNING_SECRET` — required. App settings → **Basic Information** → **App Credentials** → **Signing Secret**. Used to verify inbound `/ai-workflow` slash command requests. See `references/slash-commands.md` for the full slash-command setup.
- `SLACK_ALLOWED_USER_IDS` — optional. Comma-separated Slack user IDs (`U…`) allowed to run `/ai-workflow`. Empty = anyone in the workspace.

### Finding the channel ID

The user-friendly `#channel-name` doesn't work — Blazebot needs the `C…` ID. Two ways to find it:

- Open the channel in Slack web → URL ends in `/C0123456789`. That's the ID.
- Right-click channel in Slack desktop → "View channel details" → bottom of the modal shows the ID.

The bot must be invited to the channel: `/invite @blazebot` from inside the channel. Otherwise messages 403.

## Step 3 — Emit paste-template

```bash
CHAT_SDK_SLACK_TOKEN=<value>
CHAT_SDK_CHANNEL_ID=<value>
SLACK_SIGNING_SECRET=<value>
```

If non-default bot name:
```bash
CHAT_SDK_BOT_NAME=<value>
```

If restricting slash commands to specific users:
```bash
SLACK_ALLOWED_USER_IDS=U0123,U4567
```

Tell the user to paste into Vercel → Project Settings → Environment Variables (all three environments), save, and reply when done.

## Step 4 — Register the slash command

After the env vars are saved and the project has been deployed at least once, the operator must register the slash command in Slack:

- Slash Commands → **Create New Command** → `/ai-workflow`
- Request URL: `https://<your-vercel-domain>/webhooks/slack`
- Reinstall the app so Slack picks up the new command

Full walkthrough in `references/slash-commands.md`.

## Don'ts

- **Don't accept a `xoxp-` user token.** Blazebot needs a bot token (`xoxb-`). User tokens have different permission semantics and will silently fail in some adapter paths.
- **Don't accept a channel name (`#whatever`) as the channel ID.** The Slack API requires the ID. Save the user the silent-failure debug session.
- **Don't print the token after collecting it.** Reference by name only.
