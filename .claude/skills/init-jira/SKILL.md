---
name: init-jira
description: Set up or modify Jira configuration for the AI Workflow workflow (credentials, project key, column statuses, workflow transitions, and webhook registration). State-aware, so it detects what's already in Vercel env and runs only the missing pieces. Use for "set up jira", "configure jira board", "rotate jira token", "register jira webhook", "fix jira transitions", "jira columns setup".
---

# Initialize Jira

State-aware skill for the Jira side of AI Workflow. Two phases triggered by detected state:

- **Phase 1: Credentials and secret pre-gen.** Runs when `JIRA_BASE_URL` is not yet in Vercel env.
- **Phase 2: Webhook registration.** Runs when phase 1 is done and a production deploy exists.

> **Canonical reference:** [SETUP.md section 2.1](../../../SETUP.md#21-jira) holds the facts and constraints for Jira, and section 7 covers the webhook. This skill is the procedure; when the two disagree, SETUP.md wins and this skill gets updated.

> If you want full project setup (Jira + VCS + Agent + Slack + Neon + deploy), invoke `init-env` instead. This skill only handles Jira.

## Precondition

`apps/worker/.vercel/project.json` must exist: the worker is linked from `apps/worker` (SETUP.md section 3), and this skill's commands run there. If missing:

```
ERROR: no Vercel project linked. Run `vercel link` first, or invoke `init-env`
for the full first-time setup.
```

Halt. Do not proceed.

## State detection

On entry, run:

```bash
test -f .vercel/project.json && cat .vercel/project.json   # project name
vercel env ls | grep -wE "JIRA_BASE_URL|JIRA_API_TOKEN"    # phase 1 done?
# Also check Integrations → Jira in the dashboard: values stored there count as phase 1 done.
vercel ls --prod                                           # production deploy?
```

| `JIRA_*` set | Prod deploy | Action |
|---|---|---|
| no | any | Phase 1 |
| yes | no | Phase 1 already done; print "Webhook registration needs a production deploy first. Run `vercel --prod` then re-invoke." |
| yes | yes | Phase 2 |

---

## Phase 1: Credentials and secret pre-gen

### 1a. Has the Jira project been set up for AI Workflow?

Ask: *"Has your Jira board, statuses, and workflow transitions already been configured for AI Workflow?"*

- **No / unsure:** walk the user through these references in order, one per turn:
  - `references/column-statuses.md`: statuses must exist in Jira and match the three board column settings.
  - `references/transitions.md`: the bot must find a transition into each target status, by configured id, destination status or name (the most-missed step).
  - `references/description-format.md`: the "Acceptance Criteria" block in the description.
- **Yes:** continue.

### 1b. Generate the webhook secret

```bash
openssl rand -hex 32
```

Hold the value for the paste-template below. Even if the user later defers webhook registration, having the secret in Vercel env now means no redeploy is needed when phase 2 runs.

### 1c. Collect values

Ask in one prompt (single credential bundle):

- `JIRA_BASE_URL`: e.g. `https://acme.atlassian.net` (no trailing slash, no `/jira`)
- `JIRA_API_TOKEN`: a scoped service-account token (`read:jira-work`, `write:jira-work`) from admin.atlassian.com, Directory, Service accounts, API tokens ([SETUP.md section 2.1](../../../SETUP.md#21-jira)). A personal token from id.atlassian.com does not work: the client sends it as Bearer through api.atlassian.com.
- `JIRA_PROJECT_KEY`: e.g. `AWT`

Tell the user that the AI, AI Review, and Backlog status names are configured on the Settings page. They must match Jira status names exactly, ignoring case.

### 1d. Emit paste-template

Print this single block for the user to copy into Vercel → Project Settings → Environment Variables (set for **all three environments**: Production, Preview, Development):

```
JIRA_BASE_URL=<value>
JIRA_API_TOKEN=<value>
JIRA_PROJECT_KEY=<value>
JIRA_WEBHOOK_SECRET=<generated>
```

Tell the user to paste, save, and reply when done.

### 1e. Done

Phase 1 complete. Tell the user:

> Phase 1 done. Webhook registration will run after the first production deploy.

If invoked from `init-env`, return control. If invoked standalone, end the turn.

---

## Phase 2: Webhook registration

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
   - Name: `AI Workflow dispatch`
   - Status: `Enabled`
   - URL: the webhook URL from 2a
   - Secret: the `JIRA_WEBHOOK_SECRET` already in Vercel env (re-fetch with `vercel env ls` if the user needs to confirm it's set)
   - JQL filter: `project = "<JIRA_PROJECT_KEY>"`
   - Events: check **Issue → Issue updated** (required). Optionally **Issue created** and **Comment created** ([SETUP.md section 7](../../../SETUP.md#7-register-the-jira-webhook)).
   - Exclude body: leave **unchecked**
4. Save.

The shared route `apps/worker/src/routes/webhooks/[id].post.ts` hands the delivery to `integrations/jira/webhook.ts`, which verifies the `X-Hub-Signature` HMAC. Without `JIRA_WEBHOOK_SECRET` every delivery is refused with 503, so tickets are only found by the cron poll.

### 2c. Verify

Tell the user to drag any ticket into the AI column. They should see (in `vercel logs --prod`):

```
jira_webhook_understood        ticketKey=... webhookEvent=jira:issue_updated
ticket_event_dispatch_started
ticket_event_dispatch_result
```

The Jira card's Webhook registration health check on the Integrations page also says whether a webhook points at this deployment and sends issue updates.

If they get `401 The signature did not match.`, the secret in Jira and in Vercel env don't match: copy from `vercel env ls` again.

### 2d. Defer path

If the user cannot register the webhook now (admin permission missing, custom domain pending, etc.), record this as a TODO. The bot still works via the cron poll fallback, which runs every 15 minutes (`apps/worker/vercel.json`).

If invoked from `init-env`, return control with the TODO flag set. If standalone, print the deferred message and end.

---

## Troubleshooting

For diagnostic flows after phase 2 (signature failures, transition errors, missing PR), see `references/troubleshooting.md`.

## Don'ts

- Don't print the webhook secret value back to chat after generating it. Reference by name.
- Don't try to detect custom domains from `.vercel/project.json`: that file doesn't carry domain info reliably. Default to `<project>.vercel.app` and tell the user to swap if they have a custom domain.
- Don't subscribe to every event: **Issue updated** is required, **Issue created** and **Comment created** are the only useful optional ones, and the rest is noise the handler filters away.
