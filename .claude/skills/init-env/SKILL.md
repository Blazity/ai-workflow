---
name: init-env
description: First-time setup orchestrator for the Blazebot ai-workflow repo. Coordinates project linking, env var population across Jira / VCS / Agent / Slack / Upstash, deployment, and webhook registration in a single guided flow. Use when starting fresh on this repo for the first time — "init project", "first-time setup", "bootstrap this repo", "onboard me", "set up env from scratch".
---

# Initialize Project Environment (Cold Start)

Cold-start orchestrator. Coordinates project linking, paste-template-driven env population across 5 domains, a single production deploy, webhook registration, and a manual smoke handoff. Self-contained — does not invoke other plugins.

## What this skill does NOT do

- **Partial re-runs.** This is a cold start only. To rotate one integration later, invoke that subskill standalone (e.g. `init-jira`, `init-vcs`).
- **Local-only setup.** Vercel-only deployment track. `.env.local` is a mirror produced by `vercel env pull`, never the source of truth.
- **Auto-write secrets.** The user pastes values into the Vercel dashboard; this skill never sees them. The skill emits `.env`-format paste-templates and runbooks.

## Execution rules — read first

**Step-by-step. One step per turn. Stop and wait at every irreversible boundary.** Don't bulk through. Don't preview the next step's questions.

For each step:
1. **Announce** the step in one sentence.
2. **Run** the step's logic (subskill invocation, command, or paste-template).
3. **Pause** at irreversible boundaries (~10–12 hard pauses total). Trivial steps (printing a checklist, advancing past a confirmation) chain.
4. **End-of-turn:** at every hard pause, ask *"Ready for the next step: \<name\>?"* and wait for a yes/next/go signal.

If the user replies with anything other than a clear go-signal, do not advance — answer them, fix what they flagged, then re-ask.

## Sequence

```
0.  Pre-flight              → vercel whoami, existing-link check, team scope
1.  vercel link             → only if not already linked
2.  init-jira (phase 1)     → credentials + columns + JIRA_WEBHOOK_SECRET
3.  init-vcs                → branch on github | gitlab
4.  init-agent              → branch on claude  | codex
5.  init-slack
6.  init-upstash            → Marketplace install runbook
7.  Inline: CRON_SECRET     → auto-generate, paste-template
8.  vercel env pull         → produces .env.local
9.  Validate                → pnpm tsx --env-file=.env.local env.ts
10. vercel --prod           → single production deploy
11. init-jira (phase 2)     → webhook registration with deploy URL
12. Manual smoke            → user drags a ticket, reports result
13. Final summary
```

---

## Step 0 — Pre-flight

Run these in order. Halt with a clear message on any failure; never invoke `vercel login` from this skill.

### 0a. Authentication

```bash
vercel whoami
```

- **Fails:** HALT. Tell the user: *"Vercel CLI not authenticated. Run `vercel login`, then re-invoke `init-env`."*
- **OK:** record the current scope (team or personal) for step 0c.

### 0b. Existing link

```bash
test -f .vercel/project.json && cat .vercel/project.json
```

- **No link:** continue to step 0c.
- **Link present:** read its `orgId` / `projectId`. Print: *"Existing link found: scope=\<X\> project=\<Y\>. Use this link or relink?"*
  - **Use:** skip step 1 entirely; carry this link forward.
  - **Relink:** HALT. Tell the user: *"Remove `.vercel/project.json` (`rm .vercel/project.json`) and re-invoke `init-env`."*

### 0c. Team-scope confirmation

Compare the existing link's scope (if any) with `vercel whoami` output. If they differ, surface the mismatch explicitly. Otherwise:

Print: *"Will link to team scope: \<current-team\>. Correct?"*

- **No:** HALT. Tell the user: *"Run `vercel switch <team-name>` to change scope, then re-invoke `init-env`."*
- **Yes:** continue.

→ **Stop. Ask:** *"Pre-flight passed. Ready for Step 1: `vercel link`?"*

---

## Step 1 — `vercel link`

Skip if step 0b found a usable existing link.

```bash
vercel link
```

The CLI is interactive — let the user complete it. On success, `.vercel/project.json` is written.

**Failure handling:**
- **Permission denied:** HALT. *"Account lacks access to project \<X\>. Ask an owner to grant access, or pick a different project."*
- **Project not found and user declined to create:** HALT. *"Re-invoke `init-env` and accept Vercel's offer to create the project."*
- **Network:** HALT. *"Vercel API unreachable. Check connection and re-invoke."*

→ **Stop. Ask:** *"Linked. Ready for Step 2: Jira credentials and webhook secret?"*

---

## Step 2 — Invoke `init-jira` (phase 1)

Invoke the `init-jira` subskill via the Skill tool. It detects state and runs phase 1 because `JIRA_BASE_URL` is not yet set in Vercel:

- Asks for `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_PROJECT_KEY` / `COLUMN_AI` / `COLUMN_AI_REVIEW` / `COLUMN_BACKLOG`.
- **Pre-generates `JIRA_WEBHOOK_SECRET`** via `openssl rand -hex 32`.
- Emits a single `.env`-format paste-template.
- Walks the user through pasting into the Vercel dashboard (Project Settings → Environment Variables).
- Returns when phase 1 is complete (no verification — Decision 11 amended).

→ **Stop. Ask:** *"Jira phase 1 done. Ready for Step 3: VCS provider?"*

---

## Step 3 — Invoke `init-vcs`

Invoke `init-vcs`. It asks **github or gitlab** and emits a single paste-template for the chosen provider. Cross-field rule (`env.ts`) enforced by construction — only the chosen branch's keys are emitted.

→ **Stop. Ask:** *"VCS configured. Ready for Step 4: agent runtime?"*

---

## Step 4 — Invoke `init-agent`

Invoke `init-agent`. It asks **claude or codex** and emits a single paste-template for the chosen runtime. Defaults to API key; OAuth alternative is a documented swap in the runbook.

→ **Stop. Ask:** *"Agent runtime configured. Ready for Step 5: Slack?"*

---

## Step 5 — Invoke `init-slack`

Invoke `init-slack`. It walks the user through creating the Slack app (or finding an existing bot token), the bot's `chat:write` scope, and the channel ID format.

→ **Stop. Ask:** *"Slack configured. Ready for Step 6: Upstash Redis?"*

---

## Step 6 — Invoke `init-upstash`

Invoke `init-upstash`. It walks the user through the Vercel Marketplace install of Upstash for Redis, with the env-var prefix set to `AI_WORKFLOW_KV` so Vercel auto-injects the two keys `env.ts` expects.

→ **Stop. Ask:** *"Upstash installed. Ready for Step 7: cron secret?"*

---

## Step 7 — `CRON_SECRET` (inline)

Generate locally and emit a one-line paste-template:

```bash
openssl rand -hex 32
```

Tell the user:
*"Paste this into Vercel → Project Settings → Environment Variables for all three environments (Production, Preview, Development):"*

```
CRON_SECRET=<the generated value>
```

Without `CRON_SECRET`, the cron endpoint at `/cron/poll` accepts unauthenticated callers (`src/routes/cron/poll.get.ts:40` returns early when unset). Vercel's auto-injected `Authorization: Bearer $CRON_SECRET` only protects the endpoint when the env var is set.

→ **Stop. Ask:** *"`CRON_SECRET` set. Ready for Step 8: pull and validate?"*

---

## Step 8 — `vercel env pull` and validate

```bash
vercel env pull .env.local
pnpm tsx --env-file=.env.local env.ts
```

The validator (`env.ts` via `@t3-oss/env-core`) catches:
- Missing required keys.
- URL/email/UUID format violations.
- Cross-field violations (`VCS_KIND=github` requires `GITHUB_TOKEN/OWNER/REPO`; `AGENT_KIND=claude` requires `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; etc.).

**On failure:** the validator prints `Invalid environment variables:` followed by the specific paths. Identify the responsible subskill from the path prefix (`JIRA_*` → init-jira; `GITHUB_*` / `GITLAB_*` → init-vcs; etc.) and direct the user to fix in the Vercel dashboard, then re-run this step.

→ **Stop. Ask:** *"Validator passed. Ready for Step 9: production deploy?"*

---

## Step 9 — `vercel --prod`

```bash
vercel --prod
```

This is the first production deploy. It will:
- Build the project against the env vars now in Vercel.
- Assign the stable production URL `<project>.vercel.app`.
- Print the deploy URL on success.

**On failure:** the orchestrator pauses (does not abort). Print the deploy error verbatim, and offer:
- *"Fix the issue (commonly a missing env var the validator can't detect, or a build error) and reply `redeploy` to re-run `vercel --prod`."*

Do not auto-retry. Build errors usually need human intervention.

→ **Stop. Ask:** *"Deployed. Ready for Step 10: register the Jira webhook?"*

---

## Step 10 — Invoke `init-jira` (phase 2)

Invoke `init-jira` again. State detection now sees:
- `JIRA_*` env vars present in Vercel.
- `.vercel/project.json` exists with project name.
- A successful production deploy (this step's outcome).

Phase 2 derives the webhook URL from `.vercel/project.json` (`https://<project>.vercel.app/webhooks/jira`) and walks the user through Jira's webhook admin UI. It uses the `JIRA_WEBHOOK_SECRET` already pasted in phase 1 — no redeploy needed because the handler reads the secret at request time.

If the user opts to defer webhook registration (custom domain coming, admin permission missing, etc.), record it as a TODO for the final summary and continue.

→ **Stop. Ask:** *"Webhook registered (or deferred). Ready for Step 11: smoke test?"*

---

## Step 11 — Manual smoke

Print:

```
Last step. Drop a test ticket in Jira to verify the bot end-to-end.

  1. Open ${JIRA_BASE_URL}/jira/your-projects
  2. Create a small issue:
       - Title: "Hello from Blazebot"
       - Description: include an "Acceptance Criteria" block, e.g.
         ## Acceptance Criteria
         - The repo has a HELLO.md file
  3. Drag the ticket from the Backlog column to the AI column.

Within ~5s (with webhook) or ~60s (cron fallback), expect:
  - A bot comment on the ticket
  - A branch `blazebot/<ticket-key>` and a PR opened in your VCS
  - A Slack message in your channel
  - The ticket transitions to "AI Review"

Reply when you've seen the PR (or "stuck on X" if a step is missing).
```

Wait for the user's response. If they report a failure, capture which milestone was missing and include it in the final summary.

→ **Stop. Ask:** *"Smoke passed?"*

---

## Step 12 — Final summary

Print the summary template below, populated with the values gathered during the flow. Use the actual project name from `.vercel/project.json` and the user-reported smoke result.

```
Cold start complete.

Linked Vercel project:  <team>/<project>
Production URL:         https://<project>.vercel.app
Webhook URL:            https://<project>.vercel.app/webhooks/jira

Configured:
  Jira     <project_key>           webhook <registered | deferred>
  VCS      <github|gitlab>         <owner>/<repo>
  Agent    <claude|codex>          model <model>
  Slack    channel <id>            bot @<bot_name>
  Upstash  AI_WORKFLOW_KV prefix   via Marketplace
  Cron     CRON_SECRET set         schedule * * * * *

Skipped (you can add these later):
  - Arthur AI tracing — see https://www.arthur.ai/ for setup; both
    GENAI_ENGINE_API_KEY and GENAI_ENGINE_TRACE_ENDPOINT, then run
    `pnpm setup:arthur-prompts`.
  - Custom domain — point a domain at the Vercel project for a stable
    webhook URL (replace <project>.vercel.app in Jira's webhook config).
  - WORKFLOW_POSTGRES_URL — local dev only.
  - VERCEL_TOKEN local PAT — local dev only; Vercel uses OIDC.

Smoke test:
  <user-reported pass | fail with diagnostic>

Maintenance:
  Rotate one integration later by invoking that subskill standalone:
    init-jira | init-vcs | init-agent | init-slack | init-upstash

  Inspect the deployment:
    vercel logs --prod
    https://vercel.com/<team>/<project>/observability

No git changes were made. .env.local and .vercel/project.json are gitignored.
```

→ **Done.** Do not auto-commit, auto-push, or open a PR. The user owns git.

---

## Don'ts

- **Don't invoke `vercel login`.** It's an interactive, browser-launching flow the orchestrator can't observe. If pre-flight detects no auth, halt and tell the user.
- **Don't print or log secret values.** Reference them by name only. Pre-generated secrets (`JIRA_WEBHOOK_SECRET`, `CRON_SECRET`) appear once in the paste-template the user copies; never repeat them in summaries or logs.
- **Don't auto-retry failed deploys.** Pause, surface the error, let the user fix and reply `redeploy`.
- **Don't bulk through subskill invocations.** Each subskill is its own step; pause for the user's confirmation between them.
- **Don't auto-`vercel link` to a team without confirming.** Linking writes `.vercel/project.json` and binds future deploys.
- **Don't write `.env`.** Decision 12: skip `.env` entirely. `.env.local` (from `vercel env pull`) is the only local file. `.env.example` is committed reference.
- **Don't invent variables that aren't in `env.ts`.** If you need a new key, propose adding it to `env.ts` first.
