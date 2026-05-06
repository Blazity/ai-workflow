# Webhook setup — phase 2 detail

**Don't skip this if you can avoid it.** Without webhooks, Blazebot only polls every minute via cron, so every ticket waits up to ~60 seconds before the agent even *starts*. With webhooks, dispatch is sub-second.

## Why "Issue updated" only

The handler dispatches when the ticket lands in `COLUMN_AI` and cancels in-flight runs when it leaves. Both cases are detected on `jira:issue_updated`. Subscribing to `created`, `deleted`, etc. just adds noise that gets filtered away — the handler ignores anything without a project-key match or without an issue key.

### Optional: instant create / comment dispatch

If you want creates and new comments to dispatch immediately (rather than waiting for the next `jira:issue_updated` from a transition or edit), also check **Issue → Issue created** and **Comment → Comment created**. Tradeoff: more webhook traffic, but no perceptible latency on freshly-created tickets or replies. The handler still applies the same column/state filters either way — extra events are filtered out, not acted on.

## Open the webhook admin page

```
${JIRA_BASE_URL}/plugins/servlet/webhooks
```

Concrete: `https://acme.atlassian.net/plugins/servlet/webhooks`.

If you land on a "you don't have permission" page, you need **site admin** or **Jira admin** rights — grab someone with admin or have admin grant you the role.

Manual menu fallback: gear icon (⚙) at top-right → System → WebHooks (under "Advanced").

## Fields

| Field | Value |
|---|---|
| Name | `Blazebot dispatch` |
| Status | `Enabled` |
| URL | `https://<project>.vercel.app/webhooks/jira` (use your custom domain if you have one) |
| Secret | the value already in Vercel env as `JIRA_WEBHOOK_SECRET` |
| JQL filter | `project = "<JIRA_PROJECT_KEY>"` |
| Events | check **Issue → Issue updated** (only this one) |
| Exclude body | leave **unchecked** |

Save.

## Local testing without exposing your laptop

Use `vercel dev` + a tunnel like `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, then point the Jira webhook URL at the public tunnel. Or skip webhooks locally — the cron poller picks tickets up within ~1 minute (`POLL_INTERVAL_MS`).

## Verify

In Jira, drag any ticket into the AI column. In `vercel logs --prod`:

```
webhook_received        ticketKey=AWT-42
webhook_payload_parsed  webhookEvent=jira:issue_updated payloadStatus=AI
webhook_dispatch_started
webhook_dispatch_result started=true runId=...
```

If you see `401 Invalid webhook signature`, the secret in Jira and Vercel env don't match. Re-copy.

If you see no webhook log at all, the JQL filter or events checkbox is wrong. Check Webhooks → [your hook] → Last delivery in Jira admin.
