# Slack slash commands setup

The `/ai-workflow` slash command lets operators inspect and control workflow runs from inside Slack. Three subcommands today:

- `/ai-workflow list` — show every tracked workflow run
- `/ai-workflow status <KEY>` — show the run + sandbox tied to a Jira ticket (e.g. `AWT-42`)
- `/ai-workflow cancel <KEY>` — cancel the workflow run for a ticket

The command is gated by Slack's request signature (HMAC over the raw body) and an optional user allowlist.

## Prereqs

- The Blazebot Slack app already exists and has a bot token configured (see `bot-app-setup.md`).
- The repo is deployed at least once to Vercel — the slash command needs a public Request URL.

## Step 1 — Get the Signing Secret

In api.slack.com → your Blazebot app → **Basic Information** → **App Credentials** → **Signing Secret** → **Show** → copy.

This is `SLACK_SIGNING_SECRET`. Store it in Vercel for **all three environments** (Production, Preview, Development). Without it the route 401s every request — slash commands won't work.

## Step 2 — (Optional) Restrict who can run /ai-workflow

If you don't want any random workspace member to be able to cancel runs, set `SLACK_ALLOWED_USER_IDS` to a comma-separated list of Slack user IDs.

How to find a user ID: in Slack, click the person → **View full profile** → **More** (`⋮`) → **Copy member ID** (looks like `U0123ABCD`).

```bash
SLACK_ALLOWED_USER_IDS=U0123ABCD,U4567WXYZ
```

Leave unset for "anyone in the workspace".

## Step 3 — Register the slash command in Slack

App settings → **Slash Commands** → **Create New Command**:

| Field | Value |
| --- | --- |
| Command | `/ai-workflow` |
| Request URL | `https://<your-vercel-domain>/webhooks/slack` |
| Short description | `Inspect and control AI workflow runs` |
| Usage hint | `list \| status <KEY> \| cancel <KEY>` |

Save. If the app is already installed, Slack will prompt you to **Reinstall** so the new command is registered with the workspace.

## Step 4 — Smoke test

In any channel the bot can see:

```bash
/ai-workflow list
```

Expect:

1. An ephemeral "Working on `/ai-workflow list`…" message (within ~1s).
2. A second message visible in the channel with either the list of active runs or "No active workflows."

If you instead see Slack's "operation_timeout" error, the function probably can't reach Upstash — check Vercel runtime logs for the `slack_command_dispatching` log line.

## Troubleshooting

- **`/ai-workflow` returns "command failed with the error 'dispatch_failed'"** — Slack thinks the URL didn't 200. Check Vercel logs; usually a missing `SLACK_SIGNING_SECRET` (route 401s) or a 5xx from Nitro startup.
- **`Not authorized.`** — your user ID isn't in `SLACK_ALLOWED_USER_IDS`. Add it or unset the variable.
- **Cancel says "is mid-dispatch"** — a workflow was just claimed but not yet started. Wait a moment, then re-run the cancel.

## Rotation

Slack signing secrets don't expire but can be rotated. To rotate:

1. App settings → **Basic Information** → **Signing Secret** → **Regenerate**.
2. Update `SLACK_SIGNING_SECRET` in Vercel for all three environments.
3. Redeploy. Until the new deployment is live, every slash command will 401.
