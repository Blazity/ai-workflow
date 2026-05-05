---
name: init-jira
description: Set up or modify Jira configuration for the Blazebot workflow — credentials, project key, column statuses, workflow transitions, and webhook registration. State-aware: detects what's already in Vercel env and runs only the missing pieces. Use for "set up jira", "configure jira board", "rotate jira token", "register jira webhook", "fix jira transitions", "jira columns setup".
---

# Initialize Jira

State-aware skill for the Jira side of Blazebot. Two phases triggered by detected state:

- **Phase 1 — Credentials, columns, secret pre-gen.** Runs when `JIRA_BASE_URL` is not yet in Vercel env.
- **Phase 2 — Webhook registration.** Runs when phase 1 is done and a production deploy exists.

> If you want full project setup (Jira + VCS + Agent + Slack + Upstash + deploy), invoke `init-env` instead. This skill only handles Jira.

## Precondition

`.vercel/project.json` must exist (project must be linked). If missing:

```
ERROR: no Vercel project linked. Run `vercel link` first, or invoke `init-env`
for the full first-time setup.
```

Halt. Do not proceed.

## State detection

On entry, run:

```bash
test -f .vercel/project.json && cat .vercel/project.json   # project name
vercel env ls | grep -E "^(JIRA_BASE_URL|JIRA_API_TOKEN)"  # phase 1 done?
vercel ls --prod                                           # production deploy?
```

| `JIRA_*` set | Prod deploy | Action |
|---|---|---|
| no | — | Phase 1 |
| yes | no | Phase 1 already done; print "Webhook registration needs a production deploy first. Run `vercel --prod` then re-invoke." |
| yes | yes | Phase 2 |

---

## Phase 1 — Credentials, columns, secret pre-gen

### 1a. Has the Jira project been set up for Blazebot?

Ask: *"Has your Jira board, statuses, and workflow transitions already been configured for Blazebot?"*

- **No / unsure:** walk the user through these references in order, one per turn:
  - `references/column-statuses.md` — statuses must exist in Jira and match `COLUMN_AI` / `COLUMN_AI_REVIEW` / `COLUMN_BACKLOG`.
  - `references/transitions.md` — workflow transitions must be named exactly the same as the target statuses (the most-missed step).
  - `references/description-format.md` — the "Acceptance Criteria" block in the description.
- **Yes:** continue.

### 1b. Generate the webhook secret

```bash
openssl rand -hex 32
```

Hold the value for the paste-template below. Even if the user later defers webhook registration, having the secret in Vercel env now means no redeploy is needed when phase 2 runs.

### 1c. Collect values

Ask in one prompt (single credential bundle):

- `JIRA_BASE_URL` — e.g. `https://acme.atlassian.net` (no trailing slash, no `/jira`)
- `JIRA_EMAIL` — the bot account's email
- `JIRA_API_TOKEN` — created at https://id.atlassian.com/manage-profile/security/api-tokens
- `JIRA_PROJECT_KEY` — e.g. `AWT`

Then ask:

- `COLUMN_AI` (default `AI`)
- `COLUMN_AI_REVIEW` (default `AI Review`)
- `COLUMN_BACKLOG` (default `Backlog`)

If the user wants the defaults, fine; otherwise they must match Jira status names exactly (case-insensitive).

### 1d. Emit paste-template

Print this single block for the user to copy into Vercel → Project Settings → Environment Variables (set for **all three environments**: Production, Preview, Development):

```
JIRA_BASE_URL=<value>
JIRA_EMAIL=<value>
JIRA_API_TOKEN=<value>
JIRA_PROJECT_KEY=<value>
COLUMN_AI=<value>
COLUMN_AI_REVIEW=<value>
COLUMN_BACKLOG=<value>
JIRA_WEBHOOK_SECRET=<generated>
```

`ISSUE_TRACKER_KIND` is omitted — `env.ts` defaults it to `jira`.

Tell the user to paste, save, and reply when done.

### 1e. Done

Phase 1 complete. Tell the user:

> Phase 1 done. Webhook registration will run after the first production deploy.

If invoked from `init-env`, return control. If invoked standalone, end the turn.

---

## Phase 2 — Webhook registration

### 2a. Derive the webhook URL

Read `.vercel/project.json` to get the project name. Construct:

```
https://<project>.vercel.app/webhooks/jira
```

If the user has a custom domain configured for production traffic, they should swap the host themselves after registration. Note this in the runbook output but don't try to detect domains automatically.

### 2b. Walk the registration runbook

Hand the user `references/webhook-setup.md`. The TL;DR:

1. Open `${JIRA_BASE_URL}/plugins/servlet/webhooks` (e.g. `https://acme.atlassian.net/plugins/servlet/webhooks`).
2. Click **Create a WebHook**.
3. Fill:
   - Name: `Blazebot dispatch`
   - Status: `Enabled`
   - URL: the webhook URL from 2a
   - Secret: the `JIRA_WEBHOOK_SECRET` already in Vercel env (re-fetch with `vercel env ls` if the user needs to confirm it's set)
   - JQL filter: `project = "<JIRA_PROJECT_KEY>"`
   - Events: check **Issue → Issue updated** (only this one)
   - Exclude body: leave **unchecked**
4. Save.

The handler at `src/routes/webhooks/jira.post.ts` verifies the `X-Hub-Signature` HMAC. If `JIRA_WEBHOOK_SECRET` is unset in env, the handler skips signature verification — which is wrong for production.

### 2c. Verify

Tell the user to drag any ticket into the AI column. They should see (in `vercel logs --prod`):

```
webhook_received        ticketKey=...
webhook_payload_parsed  webhookEvent=jira:issue_updated payloadStatus=AI
webhook_dispatch_started
webhook_dispatch_result started=true runId=...
```

If they get `401 Invalid webhook signature`, the secret in Jira and in Vercel env don't match — copy from `vercel env ls` again.

### 2d. Defer path

If the user cannot register the webhook now (admin permission missing, custom domain pending, etc.), record this as a TODO. The bot still works via cron poll fallback (~60s lag per ticket).

If invoked from `init-env`, return control with the TODO flag set. If standalone, print the deferred message and end.

---

## Troubleshooting

For diagnostic flows after phase 2 (signature failures, transition errors, missing PR), see `references/troubleshooting.md`.

## Don'ts

- Don't print the webhook secret value back to chat after generating it. Reference by name.
- Don't try to detect custom domains from `.vercel/project.json` — that file doesn't carry domain info reliably. Default to `<project>.vercel.app` and tell the user to swap if they have a custom domain.
- Don't skip the **Issue updated** event filtering — subscribing to all events floods the handler with noise that gets filtered away anyway.
