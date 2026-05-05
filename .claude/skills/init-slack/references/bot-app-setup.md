# Slack bot app setup

If your workspace already has a Blazebot app, skip this — get the existing token and channel from your Slack admin.

## Create the app

1. Open https://api.slack.com/apps → **Create New App** → **From scratch**.
2. App Name: `Blazebot` (or whatever you like).
3. Pick the workspace.
4. Click **Create App**.

## Add bot scopes

In the app settings sidebar:

1. **OAuth & Permissions** → **Scopes** → **Bot Token Scopes** → **Add an OAuth Scope**.
2. Add these scopes:
   - `chat:write` — required. Lets the bot post messages.
   - `chat:write.public` — optional. Lets the bot post in public channels it isn't a member of. Skip if you'll always invite the bot.
   - `users:read` — optional. For mentioning specific users in messages.

Only `chat:write` is hard-required.

## Install the app to the workspace

1. Still on **OAuth & Permissions** → **Install to Workspace** → **Allow**.
2. After install, copy the **Bot User OAuth Token** at the top of the page. It starts with `xoxb-`. This is `CHAT_SDK_SLACK_TOKEN`.

## Invite the bot to the channel

In the Slack channel you want bot messages in:

```
/invite @blazebot
```

Without this, messages 403. (Workaround: add `chat:write.public` scope and skip the invite, but cleaner to just invite.)

## Find the channel ID

- Open the channel in Slack web → URL is `https://app.slack.com/client/T.../C0123456789`. That `C…` is the ID.
- Or: right-click channel → **View channel details** → bottom of modal shows the ID.

This is `CHAT_SDK_CHANNEL_ID`.

## Verify

```bash
curl -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $CHAT_SDK_SLACK_TOKEN" \
  -H "Content-type: application/json; charset=utf-8" \
  --data "{\"channel\":\"$CHAT_SDK_CHANNEL_ID\",\"text\":\"hello from blazebot setup\"}"
```

Should return `{"ok":true,...}` and a message appears in the channel.

Common errors:
- `not_in_channel` — invite the bot.
- `channel_not_found` — wrong ID format (used `#name` instead of `C…`).
- `invalid_auth` — wrong token.
- `missing_scope` — `chat:write` not added.

## Rotation

Slack bot tokens don't expire but can be revoked. To rotate:

1. App settings → **OAuth & Permissions** → **Reissue token** (under Bot User OAuth Token).
2. Update Vercel env, redeploy.
