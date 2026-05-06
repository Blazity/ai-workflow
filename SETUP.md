# ai-workflow — Setup & Deployment Guide

End-to-end instructions for deploying ai-workflow to your own Vercel account. Read the [README](./README.md) first for architectural context.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Provision external accounts](#2-provision-external-accounts)
3. [Clone the repo and link to Vercel](#3-clone-the-repo-and-link-to-vercel)
4. [Install the Upstash marketplace integration](#4-install-the-upstash-marketplace-integration)
5. [Configure environment variables](#5-configure-environment-variables)
6. [Local development (optional)](#6-local-development-optional)
7. [Deploy to Vercel](#7-deploy-to-vercel)
8. [Register the Jira webhook](#8-register-the-jira-webhook)
9. [Register the Slack slash command](#9-register-the-slack-slash-command)
10. [Smoke test the deployment](#10-smoke-test-the-deployment)
11. [CI / GitHub Actions](#11-ci--github-actions)
12. [Optional integrations](#12-optional-integrations)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Prerequisites

Local toolchain:

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | https://nodejs.org |
| pnpm | 10+ | `npm i -g pnpm` |
| Vercel CLI | latest | `npm i -g vercel@latest` |
| Git | 2.40+ | https://git-scm.com |

Accounts you must own:

- **Vercel** — Pro plan recommended (Cron Jobs, Sandbox, Workflow are paid features on Hobby).
- **Atlassian Jira Cloud** — admin access on the project to manage columns, transitions, and webhooks.
- **GitHub** *or* **GitLab** — admin on the target repository (PR + branch creation).
- **Slack** workspace — admin to install a custom app and register slash commands.
- **Anthropic** *or* **OpenAI** — API key for the agent runtime.
- **Upstash** — installed via Vercel Marketplace in step 4.

---

## 2. Provision external accounts

Do these in any order — you'll paste the resulting values into Vercel in step 5.

### 2.1 Jira

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens and create an API token. Save it as `JIRA_API_TOKEN`.
2. Note your Atlassian instance URL (e.g. `https://your-domain.atlassian.net`) → `JIRA_BASE_URL`.
3. Note the email of the Jira user the token belongs to → `JIRA_EMAIL`.
4. Open the project ai-workflow will operate on. Note its key (e.g. `AWT`) → `JIRA_PROJECT_KEY`.
5. On the project board, identify the three columns ai-workflow uses. Create them if they don't exist:
   - `COLUMN_AI` — tickets assigned to the agent (default: `AI`)
   - `COLUMN_AI_REVIEW` — completed tickets pending human review (default: `AI Review`)
   - `COLUMN_BACKLOG` — tickets bounced back for clarification (default: `Backlog`)
6. Generate a webhook secret to authenticate Jira → Vercel deliveries:
   ```bash
   openssl rand -hex 32
   ```
   Save as `JIRA_WEBHOOK_SECRET`. You'll register the webhook itself in step 8.

> Without a webhook, dispatch falls back to the 1-minute cron poll — workable for testing, sluggish in production.

### 2.2 GitHub (or GitLab)

**GitHub:**
1. Create a fine-grained or classic PAT with `repo` scope at https://github.com/settings/tokens → `GITHUB_TOKEN`.
2. Note the target repo's `owner` and `name` → `GITHUB_OWNER`, `GITHUB_REPO`.
3. Note the base branch (usually `main`) → `GITHUB_BASE_BRANCH`.

**GitLab:**
1. Create a project access token (or PAT) with `api`, `read_repository`, `write_repository` scopes → `GITLAB_TOKEN`.
2. Note the project ID or `group/repo` path → `GITLAB_PROJECT_ID`.
3. For self-hosted, set `GITLAB_HOST` to your instance base URL.

### 2.3 Slack

1. Create a new Slack app at https://api.slack.com/apps → **From scratch**.
2. Under **OAuth & Permissions**, add bot scopes: `chat:write`, `commands`, `files:read`, `users:read`.
3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`) → `CHAT_SDK_SLACK_TOKEN`.
4. Under **Basic Information → App Credentials**, copy **Signing Secret** → `SLACK_SIGNING_SECRET`.
5. In the Slack client, right-click the destination channel → **View channel details** → copy the channel ID (`C...`) → `CHAT_SDK_CHANNEL_ID`. Invite the bot to the channel.
6. Optional: choose a display name → `CHAT_SDK_BOT_NAME` (default `blazebot`).

The slash command itself is registered in step 9 (after you have a deployment URL).

### 2.4 Agent runtime

Pick one — controlled by `AGENT_KIND`.

**Claude (default):**
- Create an API key at https://console.anthropic.com → `ANTHROPIC_API_KEY`.
- Optionally pin a model: `CLAUDE_MODEL=claude-opus-4-6` (default).

**Codex:**
- `AGENT_KIND=codex`
- `CODEX_API_KEY=sk-...` (or `CODEX_CHATGPT_OAUTH_TOKEN`)
- Optionally `CODEX_MODEL=gpt-5-codex`.

---

## 3. Clone the repo and link to Vercel

```bash
git clone <your-fork-or-this-repo>.git
cd ai-workflow
pnpm install
vercel link
```

`vercel link` walks you through selecting the team and either creating a new project or linking to an existing one. The result is `.vercel/project.json` — keep it out of source control (already gitignored).

---

## 4. Install the Upstash marketplace integration

ai-workflow uses Upstash Redis as its run registry (atomic claim/release for concurrent runs).

1. Open https://vercel.com/marketplace/upstash and click **Install**.
2. Pick the team and project you just linked.
3. **Critical:** when prompted for the env-var prefix, set it to `AI_WORKFLOW_KV`. The code reads `AI_WORKFLOW_KV_REST_API_URL` and `AI_WORKFLOW_KV_REST_API_TOKEN` — wrong prefix means ai-workflow can't find the registry.
4. Vercel auto-injects both vars into Production, Preview, and Development environments.

Verify:
```bash
vercel env ls | grep AI_WORKFLOW_KV
```

---

## 5. Configure environment variables

Two paths — pick the one that matches your workflow.

### 5a. Via Vercel Dashboard (recommended for production)

Open **Project → Settings → Environment Variables** and add every required variable from the table below. Set scope to **Production, Preview, Development** unless noted otherwise.

### 5b. Via the CLI

```bash
cp .env.example .env
# fill in values, then:
vercel env add JIRA_BASE_URL production
vercel env add JIRA_API_TOKEN production
# ... repeat
```

### Required variables

| Variable | Purpose |
|----------|---------|
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` | Jira credentials |
| `COLUMN_AI`, `COLUMN_AI_REVIEW`, `COLUMN_BACKLOG` | Board columns |
| `VCS_KIND` | `github` or `gitlab` |
| `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` | If `VCS_KIND=github` |
| `GITLAB_TOKEN`, `GITLAB_PROJECT_ID` | If `VCS_KIND=gitlab` |
| `CHAT_SDK_SLACK_TOKEN`, `CHAT_SDK_CHANNEL_ID` | Slack bot |
| `SLACK_SIGNING_SECRET` | Verifies `/ai-workflow` slash commands |
| `AGENT_KIND` | `claude` (default) or `codex` |
| `ANTHROPIC_API_KEY` | If `AGENT_KIND=claude` |
| `CODEX_API_KEY` | If `AGENT_KIND=codex` |
| `AI_WORKFLOW_KV_REST_API_URL`, `AI_WORKFLOW_KV_REST_API_TOKEN` | Auto-injected by Upstash integration |
| `CRON_SECRET` | Generate: `openssl rand -hex 32`. Required so `/cron/poll` rejects unauthenticated callers. |
| `JIRA_WEBHOOK_SECRET` | Generate: `openssl rand -hex 32`. Strongly recommended — without it, dispatch is cron-bound. |

### Optional / has defaults

| Variable | Default | Purpose |
|----------|---------|---------|
| `GITHUB_BASE_BRANCH` | `main` | PR target branch |
| `CHAT_SDK_BOT_NAME` | `blazebot` | Slack display name |
| `SLACK_ALLOWED_USER_IDS` | empty (anyone) | Comma-separated user IDs allowed to run slash commands |
| `CLAUDE_MODEL` | `claude-opus-4-6` | Anthropic model |
| `CODEX_MODEL` | `gpt-5-codex` | Codex model |
| `MAX_CONCURRENT_AGENTS` | `3` | Parallel sandbox cap |
| `JOB_TIMEOUT_MS` | `1800000` (30 min) | Per-run timeout |
| `POLL_INTERVAL_MS` | `300000` (5 min) | Internal poll cadence |
| `COMMIT_AUTHOR`, `COMMIT_EMAIL` | `ai-workflow-blazity`, `ai-workflow@blazity.com` | Git identity inside sandboxes |

`env.ts` cross-validates at startup — missing required vars or wrong combinations (e.g. `VCS_KIND=github` without `GITHUB_OWNER`) crash the process with a precise error.

---

## 6. Local development (optional)

For local runs, pull the Vercel env (provisions OIDC tokens for Sandbox auth automatically):

```bash
vercel env pull .env.local
```

Vercel Workflows needs a local Postgres for durable state in dev:

```bash
# example with Docker
docker run -d --name workflow-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
createdb -h localhost -U postgres ai_workflow

# add to .env.local
WORKFLOW_POSTGRES_URL=postgresql://postgres:postgres@localhost:5432/ai_workflow
```

Run:
```bash
pnpm dev
curl http://localhost:3000/health   # → {"status":"ok",...}
```

If `vercel env pull` doesn't cover Sandbox auth, set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` manually.

---

## 7. Deploy to Vercel

### First deploy (preview)

```bash
vercel
```

Confirm the preview URL works:
```bash
curl https://<preview-url>/health
```

### Promote to production

```bash
vercel --prod
```

Or push to your production branch if you've connected the Vercel Git integration — production deployments fire automatically.

### What deploys

- HTTP routes from `src/routes/` — health, cron, webhooks, slash commands.
- Vercel Workflow definitions — workflow state is managed by Vercel in production (no Postgres needed).
- Cron job from `vercel.json` (`* * * * *` → `/cron/poll`) — activates automatically. Vercel injects the `CRON_SECRET` auth header.

---

## 8. Register the Jira webhook

Without this, ai-workflow only learns about ticket changes via the 1-minute cron poll.

1. Go to **Jira → System Settings → WebHooks** (admin only) or use the Atlassian REST API.
2. Create a webhook:
   - **URL:** `https://<your-vercel-domain>/webhooks/jira`
   - **Secret:** the `JIRA_WEBHOOK_SECRET` value from step 5. Jira signs each delivery with HMAC-SHA256 in the `X-Hub-Signature` header; the handler at `src/routes/webhooks/jira.post.ts` verifies it with `timingSafeEqual`.
   - **Events:** `jira:issue_updated` (required). Add `jira:issue_created` and `comment_created` if you want creates and comments to dispatch instantly.
   - **JQL filter** (optional): `project = AWT` to limit deliveries to the relevant project.
3. Save.

Verify by moving a test ticket into the AI column and watching the Vercel runtime logs.

---

## 9. Register the Slack slash command

1. In your Slack app config, go to **Slash Commands → Create New Command**.
2. Configure:
   - **Command:** `/ai-workflow`
   - **Request URL:** `https://<your-vercel-domain>/webhooks/slack`
   - **Short description:** `Manage ai-workflow runs`
   - **Usage hint:** `list | status <KEY> | cancel <KEY>`
3. Save and **reinstall the app** to your workspace if Slack prompts you.
4. Confirm `SLACK_SIGNING_SECRET` is set in Vercel (step 5) — `/webhooks/slack` rejects requests with bad signatures.

Test in Slack:
```
/ai-workflow list
```

If you set `SLACK_ALLOWED_USER_IDS`, only those Slack user IDs can invoke the command — useful for limiting to your engineering team.

> See `.claude/skills/init-slack/references/slash-commands.md` for the full walkthrough.

---

## 10. Smoke test the deployment

### Health
```bash
curl https://<your-vercel-domain>/health
# → {"status":"ok","timestamp":"..."}
```

### Cron auth
```bash
curl https://<your-vercel-domain>/cron/poll
# → 401 Unauthorized

curl -H "Authorization: Bearer $CRON_SECRET" https://<your-vercel-domain>/cron/poll
# → 200 with the poll result
```

### End-to-end
1. Create a test Jira ticket with a clear acceptance criterion (e.g. "add a `/ping` route returning `pong`").
2. Move it to the **AI** column.
3. Within ~1 minute (cron) or instantly (webhook), watch:
   - Vercel logs — workflow starts, sandbox provisions.
   - Jira ticket — moves to **AI Review** (success) or **Backlog** (clarification needed).
   - Target repo — new branch `blazebot/<ticket-key>` and an open PR.
   - Slack channel — notification fires.

If anything stalls, jump to [troubleshooting](#13-troubleshooting).

---

## 11. CI / GitHub Actions

Two workflows ship in `.github/workflows/`:

- **`ci.yml`** — runs on pull requests against `main`/`dev` and on `merge_group` events. The `ci` job runs typecheck + unit tests with no secrets. The merge-queue path additionally runs `e2e-orchestration → e2e-capacity → e2e-agent` against the same `e2e` GitHub environment.
- **`e2e.yml`** — manual `workflow_dispatch` with two inputs:
  - `tier`: `orchestration` | `capacity` | `agent` | `all` (default `all`).
  - `agent`: `claude` | `codex` — passed as `E2E_AGENT_KIND`, only consumed by the `agent` tier.

  Tiers and timeouts:
  - **orchestration** — dispatch / cron / webhook (60 min).
  - **capacity** — concurrency, claim/release, reconciler (30 min, gated on orchestration).
  - **agent** — full ticket → PR run against real Jira + GitHub (120 min, gated on capacity).

The E2E jobs need the production env vars exposed as GitHub Actions secrets in the `e2e` environment (Repo Settings → Environments → e2e → Secrets). They additionally require `E2E_BASE_URL`, `E2E_GITHUB_TOKEN`, `E2E_GITHUB_OWNER`, `E2E_GITHUB_REPO`, and `VERCEL_AUTOMATION_BYPASS_SECRET`.

---

## 12. Optional integrations

### Arthur AI Engine (tracing + hosted prompts)

Set both:
```bash
GENAI_ENGINE_API_KEY=...
GENAI_ENGINE_TRACE_ENDPOINT=https://your-arthur-host/api/v1/traces
```

Then run once to register hosted prompts:
```bash
pnpm setup:arthur-prompts
# saves the resulting task ID — set it as:
GENAI_ENGINE_PROMPT_TASK_ID=<uuid>
```

The tracer is built into every sandbox via `pnpm build:arthur-tracer` during deploy.

### GitLab instead of GitHub

Flip `VCS_KIND=gitlab` and provide `GITLAB_TOKEN` + `GITLAB_PROJECT_ID`. For self-hosted, also set `GITLAB_HOST`. `GITHUB_*` vars become inert.

---

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Startup crash: `Invalid environment variables` | Missing required var or wrong cross-field combination | Read the error — `env.ts` lists exactly what's missing. |
| `/cron/poll` returns 401 from Vercel Cron | `CRON_SECRET` mismatch | Ensure the var is set in Production environment. Redeploy after changing. |
| Tickets in AI column never get picked up | Cron disabled / webhook misregistered | Check **Vercel → Project → Cron Jobs** is enabled. Curl `/cron/poll` with the secret to test manually. |
| Workflow starts but sandbox fails to provision | Missing Vercel OIDC / Sandbox quota | On Vercel, OIDC is automatic. Check the project has Sandbox enabled (Pro plan). For local dev, set `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`. |
| Run registry: `AI_WORKFLOW_KV_REST_API_URL undefined` | Upstash integration installed with wrong prefix | Reinstall with prefix `AI_WORKFLOW_KV`. |
| Agent runs but PR isn't created | `GITHUB_TOKEN` lacks `repo` scope, or wrong owner/repo | Re-create the PAT with `repo` scope. Verify `GITHUB_OWNER`/`GITHUB_REPO` point at the *target* repo, not this repo. |
| Slack messages don't arrive | Bot not in channel, or wrong `CHAT_SDK_CHANNEL_ID` | Invite bot to the channel. Re-copy the channel ID. |
| Slash command returns `dispatch_failed` | Signing secret wrong, or app not reinstalled | Verify `SLACK_SIGNING_SECRET`. Reinstall the Slack app after adding the slash command. |
| Two pollers race on the same ticket | Stale claim sentinel | The reconciler clears claims older than 5 minutes on every poll — wait one cycle, or flush the registry key in Upstash. |
| Sandbox times out | Job too large for `JOB_TIMEOUT_MS` | Increase to 60–90 minutes for complex tickets, or split the work. |

### Useful logs

- **Vercel runtime logs:** `vercel logs <deployment-url>` or **Project → Logs**.
- **Workflow runs:** **Project → Workflows** in the Vercel dashboard — shows step-by-step state, failures, retries.
- **Local logs:** Pino prints structured JSON. Pipe through `pnpm dlx pino-pretty`.

---

## Reference

- Architecture and workflow internals → [README.md](./README.md)
- Spec → [docs/SPEC.md](./docs/SPEC.md)
- User stories → [docs/user-stories.md](./docs/user-stories.md)
- Per-integration walkthroughs → `.claude/skills/init-*/` (Jira, Slack, Upstash, VCS, agent runtime)
