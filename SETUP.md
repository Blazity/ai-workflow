# ai-workflow — Setup & Deployment Guide

End-to-end instructions for deploying ai-workflow to your own Vercel account. Read the [README](./README.md) first for architectural context.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Provision external accounts](#2-provision-external-accounts)
3. [Clone the repo and link to Vercel](#3-clone-the-repo-and-link-to-vercel)
4. [Install the Neon Postgres marketplace integration](#4-install-the-neon-postgres-marketplace-integration)
5. [Configure environment variables](#5-configure-environment-variables)
6. [Deploy to Vercel](#6-deploy-to-vercel)
7. [Register the Jira webhook](#7-register-the-jira-webhook)
8. [Register the GitHub webhook (post-PR gate)](#8-register-the-github-webhook-post-pr-gate)
9. [Register the Slack slash command](#9-register-the-slack-slash-command)
10. [Smoke test the deployment](#10-smoke-test-the-deployment)
11. [CI / GitHub Actions](#11-ci--github-actions)
12. [Optional integrations](#12-optional-integrations)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Prerequisites

Local toolchain:

| Tool       | Version | Install                  |
| ---------- | ------- | ------------------------ |
| Node.js    | 20+     | https://nodejs.org       |
| pnpm       | 10+     | `npm i -g pnpm`          |
| Vercel CLI | latest  | `npm i -g vercel@latest` |
| Git        | 2.40+   | https://git-scm.com      |

Accounts you must own:

- **Vercel** — Pro plan recommended (Cron Jobs, Sandbox, Workflow are paid features on Hobby).
- **Atlassian Jira Cloud** — admin access on the project to manage columns, transitions, and webhooks.
- **GitHub** _or_ **GitLab** — admin on the target repository (PR + branch creation).
- **Slack** workspace — admin to install a custom app and register slash commands.
- **Anthropic** _or_ **OpenAI** — API key for the agent runtime.
- **Neon Postgres** — installed via Vercel Marketplace in step 4.

---

## 2. Provision external accounts

Do these in any order — you'll paste the resulting values into Vercel in step 5.

### 2.1 Jira

ai-workflow authenticates to Jira as an **Atlassian service account** — a machine identity managed in the organization admin, with no human login. Tokens are Bearer-style and routed through `api.atlassian.com/ex/jira/{cloudId}`. Don't use a personal API token from a real user account: rotation, audit, and least-privilege all break down when the bot shares identity with a human.

**Create the service account** (requires Atlassian org admin):

1. Go to **https://admin.atlassian.com** → pick your organization → **Directory** → **Service accounts**.
2. **Create service account** → name it (e.g. `ai-workflow`) → grant product access to **Jira** only.

**Generate a scoped API token:**

1. Back in **admin.atlassian.com → Directory → Service accounts**, open the account you just created → **API tokens** → **Create credentials**. Give it a label (e.g. `ai-workflow-prod`) and pick these two **classic** scopes:

   | Scope             | Covers                                                                                                                                                          |
   | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `read:jira-work`  | `GET /issue/{id}` (summary, description, comments, labels, status, project, attachments), `GET /issue/{id}/transitions`, `GET /search/jql`, attachment download |
   | `write:jira-work` | `POST /issue/{id}/comment`, `POST /issue/{id}/transitions` (move ticket)                                                                                        |

2. Copy the token immediately (it's shown once) → `JIRA_API_TOKEN`.

> **Scope ≠ project permissions.** The token's scopes (`read:jira-work`, `write:jira-work`) gate _which API categories_ the token can call — but `write:jira-work` covers destructive endpoints like `DELETE /issue/{id}` too. The second gate is the project's **Permission Scheme** in Jira itself: the service account is a regular Jira user, and Jira filters every request by that user's permissions on the project.
>
> Concretely: leave the service account in `jira-users` (default) and make sure your project's Permission Scheme does **not** grant `Delete Issues`, `Delete All Comments`, `Delete All Attachments`, `Administer Projects`, or `Manage Sprints` to `jira-users` or `Any logged in user`. Atlassian's `Default Permission Scheme` ships this way out of the box — verify at `<site>/secure/admin/ViewPermissionSchemes.jspa` → find `Default Permission Scheme` → click **Permissions**. A `DELETE` from the bot will then return `403 You do not have permission to delete issues in this project.` even though the token scope allows the call. If you need stricter isolation (e.g. hide the bot from other projects), create a dedicated group + dedicated scheme — otherwise the default should be sufficient.

**Capture the rest of the config:**

1. Note your Atlassian instance URL (e.g. `https://your-domain.atlassian.net`) → `JIRA_BASE_URL`.
2. Open the project ai-workflow will operate on. Note its key (e.g. `AWT`) → `JIRA_PROJECT_KEY`.
3. On the project board, identify the three columns ai-workflow uses. Create them if they don't exist:
   - `COLUMN_AI` — tickets assigned to the agent (default: `AI`)
   - `COLUMN_AI_REVIEW` — completed tickets pending human review (default: `AI Review`)
   - `COLUMN_BACKLOG` — tickets bounced back for clarification (default: `Backlog`)
4. Generate a webhook secret to authenticate Jira → Vercel deliveries:
   ```bash
   openssl rand -hex 32
   ```
   Save as `JIRA_WEBHOOK_SECRET`. You'll register the webhook itself in step 7.

> Without a webhook, dispatch falls back to the 1-minute cron poll — workable for testing, sluggish in production.

### 2.2 GitHub (or GitLab)

**GitHub (GitHub App — required):**

ai-workflow authenticates to GitHub via a **GitHub App**. The App scopes the bot to a single installation, commits as `<app-slug>[bot]`, and lets you rotate the private key without touching a human account. See [`docs/GITHUB-APP-SETUP.md`](./docs/GITHUB-APP-SETUP.md) for the full step-by-step walkthrough — the short version:

1. Go to **https://github.com/settings/apps → New GitHub App**.
2. Set **Webhook → Active** to **on**, set the URL to `https://<your-deployment>/webhooks/github` (placeholder ok pre-deploy), and generate a secret (`openssl rand -hex 32`) → `GITHUB_WEBHOOK_SECRET`. The post-PR gate verifies `X-Hub-Signature-256` on every delivery.
3. Under **Repository permissions**, grant exactly:

   | Permission    | Access       | Why                                                                       |
   | ------------- | ------------ | ------------------------------------------------------------------------- |
   | Contents      | Read & write | Clone the repo, push commits                                              |
   | Pull requests | Read & write | Create PRs, fetch PR data                                                 |
   | Issues        | Read & write | PR review comments live on the issues API                                 |
   | Checks        | Read & write | Read CI check results + create post-PR gate check runs                    |
   | Actions       | Read-only    | Read workflow run status                                                  |
   | Metadata      | Read-only    | Mandatory, auto-included                                                  |

   Leave every other permission at **No access**.

4. Under **Subscribe to events**, enable **Pull request** (drives the post-PR gate on `opened` / `synchronize` / `reopened`). Leave everything else unchecked.
5. Choose **Only on this account** for installation scope, create the app, then **Install App** on the target repo's owner and select that one repo. If you change permissions later, every installed repo will need a one-click re-acceptance from a repo admin.
6. From the app settings page, capture:
   - **App ID** → `GITHUB_APP_ID`
   - **Generate a private key** → download the `.pem`. Base64-encode the file contents (`base64 -i app.pem | tr -d '\n'`) → `GITHUB_APP_PRIVATE_KEY`.
   - From the **Installations** list, the numeric installation ID → `GITHUB_INSTALLATION_ID`.
7. Note the target repo's `owner` and `name` → `GITHUB_OWNER`, `GITHUB_REPO`.
8. Note the base branch (usually `main`) → `GITHUB_BASE_BRANCH`.

> The legacy `GITHUB_TOKEN` PAT path was removed — `VCS_KIND=github` now requires the App vars above. `env.ts` enforces this at boot, including `GITHUB_WEBHOOK_SECRET`.

**GitLab:**

For GitLab.com single-project setup, see [`docs/GITLAB-SETUP.md`](./docs/GITLAB-SETUP.md). The short version:

1. Create a Project Access Token when available, or a dedicated bot/service-account PAT if project tokens are unavailable. Grant the `api` scope → `GITLAB_TOKEN`.
2. Note the numeric project ID or `group/repo` path → `GITLAB_PROJECT_ID`.
3. Generate a random webhook secret → `GITLAB_WEBHOOK_SECRET`.
4. Note the base branch (usually `main`) → `GITLAB_BASE_BRANCH`.

### 2.3 Slack

The Slack app powers two things: **notifications** (run start, success, failure messages posted to a channel) and the **`/ai-workflow` slash command** (registered later in step 8).

**Create the app:**

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**. Name it (e.g. `ai-workflow`) and pick the workspace.
2. Under **OAuth & Permissions → Bot Token Scopes**, add exactly:

   | Scope        | Why                                                      |
   | ------------ | -------------------------------------------------------- |
   | `chat:write` | Post notifications to the channel                        |
   | `commands`   | Register and respond to the `/ai-workflow` slash command |

   Don't add `chat:write.public` unless you want the bot to post in channels it isn't a member of — keeping it out forces the explicit invite below, which is what you want.

3. Click **Install to Workspace** and approve. Copy the **Bot User OAuth Token** (`xoxb-...`) → `CHAT_SDK_SLACK_TOKEN`.
4. Under **Basic Information → App Credentials**, copy **Signing Secret** → `SLACK_SIGNING_SECRET`. This authenticates incoming slash-command requests.

**Wire up notifications:**

5. Pick (or create) the channel where ai-workflow should post — e.g. `#ai-workflow` or your team's engineering channel. Public is simplest; private works as long as you invite the bot.
6. In Slack, open the channel → **Channel details → Integrations → Add apps** → select the ai-workflow app you just installed. (Or run `/invite @ai-workflow` in the channel.) Without this the bot's posts will fail with `not_in_channel`.
7. Right-click the channel → **View channel details** → copy the channel ID at the bottom (looks like `C0123456789`) → `CHAT_SDK_CHANNEL_ID`.
8. Optional: choose a display name → `CHAT_SDK_BOT_NAME` (default `blazebot`). This is what users see as the message author.
9. Optional: restrict who can invoke the slash command by setting `SLACK_ALLOWED_USER_IDS` to a comma-separated list of Slack user IDs (`U0123…`). When unset, anyone in the workspace can run it.

> If you skip the Slack section entirely (`CHAT_SDK_SLACK_TOKEN` and `CHAT_SDK_CHANNEL_ID` unset), runs proceed silently — Jira and PRs still update, just no chat notifications.

The slash command itself is registered in step 8 (after you have a deployment URL). For the deeper walkthrough, see [`.claude/skills/init-slack/`](./.claude/skills/init-slack/).

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

This repo is a **pnpm workspace monorepo** (see the [Repository Layout](./README.md#repository-layout) section of the README). `pnpm install` from the root installs every app at once:

```bash
git clone <your-fork-or-this-repo>.git
cd ai-workflow
pnpm install
```

The two deployable apps — `apps/worker` (the bot) and `apps/dashboard` (the cockpit) — deploy as **separate Vercel projects**, each linked from its own directory. Link the worker now; the dashboard is optional and covered under [Optional integrations → Dashboard](#dashboard-cockpit--observability-ui).

```bash
cd apps/worker
vercel link
cd ../..
```

`vercel link` walks you through selecting the team and either creating a new project or linking to an existing one. Running it from `apps/worker` produces `apps/worker/.vercel/project.json` and pins the project's **Root Directory** to `apps/worker`, so Vercel builds the worker (and picks up its `vercel.json` cron) rather than the repo root. The `.vercel/` dir is gitignored — keep it out of source control.

> If you instead create the project through the Vercel dashboard, set **Project → Settings → Build & Development → Root Directory** to `apps/worker` manually.

---

## 4. Install the Neon Postgres marketplace integration

ai-workflow uses Neon Postgres as its run registry and post-PR-gate store
(atomic claim/release for concurrent runs, dedupe, locking). Tables are
created automatically — migrations run during every deploy's build step.

1. Open https://vercel.com/marketplace/neon and click **Install**.
2. Connect it to the ai-workflow Vercel project.
3. **Critical:** enable a **separate branch per environment** (development /
   preview / production) when configuring the integration. Each environment's
   `DATABASE_URL` must point at its own Neon branch. The build fails with an
   `env_marker` error if two environments share one branch — that guard
   protects the production run registry from preview deployments.

Verify:

```bash
vercel env ls | grep DATABASE_URL
```

You should see `DATABASE_URL` present for each environment. (`vercel env ls`
shows values as Encrypted, so it can't confirm branch isolation — use the
pull-and-compare check in `.claude/skills/init-neon/` to verify each
environment points at its own Neon branch.)

---

## 5. Configure environment variables

Two paths — pick the one that matches your workflow.

### 5a. Via Vercel Dashboard (recommended for production)

Open **Project → Settings → Environment Variables** and add every required variable from the table below. Set scope to **Production, Preview, Development** unless noted otherwise.

### 5b. Via the CLI

The worker's vars belong to the worker's Vercel project, so run these from `apps/worker` (where you linked in step 3):

```bash
cd apps/worker
cp .env.example .env
# fill in values, then:
vercel env add JIRA_BASE_URL production
vercel env add JIRA_API_TOKEN production
# ... repeat
```

### Required variables

| Variable                                                                                           | Purpose                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `JIRA_BASE_URL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`                                              | Jira credentials (scoped service-account Bearer token) |
| `COLUMN_AI`, `COLUMN_AI_REVIEW`, `COLUMN_BACKLOG`                                                  | Board columns                                          |
| `VCS_KIND`                                                                                         | `github` or `gitlab`                                   |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_OWNER`, `GITHUB_REPO` | If `VCS_KIND=github` (GitHub App auth)                 |
| `GITHUB_WEBHOOK_SECRET`                                                                            | If `VCS_KIND=github` — signs `pull_request` webhook deliveries for the post-PR gate. Required in **every** environment (Production, Preview, Development) because the webhook fires on preview deployments too. Generate: `openssl rand -hex 32`. |
| `GITLAB_TOKEN`, `GITLAB_PROJECT_ID`, `GITLAB_WEBHOOK_SECRET`                                       | If `VCS_KIND=gitlab` — GitLab.com API token, project id/path, and merge request webhook secret. Generate: `openssl rand -hex 32`. |
| `ANTHROPIC_API_KEY`                                                                                | If `AGENT_KIND=claude` (default)                       |
| `CODEX_API_KEY` (or `CODEX_CHATGPT_OAUTH_TOKEN`)                                                   | If `AGENT_KIND=codex`                                  |
| `DATABASE_URL`                                                                                     | Auto-injected by Neon integration                      |
| `BETTER_AUTH_SECRET` | Signing/encryption key for Better Auth (dashboard human login). At least 32 chars. Generate: `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | The worker's own base URL (no trailing slash) — Better Auth's `baseURL`. |
| `DASHBOARD_ORIGIN` | The dashboard deployment's origin, added to Better Auth `trustedOrigins`. |
| `DASHBOARD_AUTH_EMAIL` | Email of the single predefined dashboard admin (seeded at build; no registration UI). |
| `DASHBOARD_AUTH_PASSWORD` | Password for that admin. Changing it re-hashes on the next deploy. |

This is enough for password-only dashboard login. SSO and Resend are optional worker-side additions.

### Optional / has defaults

| Variable                                      | Default                                                                                                                                                     | Purpose                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_BASE_BRANCH`                          | `main`                                                                                                                                                      | PR target branch                                                                                                                 |
| `CHAT_SDK_SLACK_TOKEN`, `CHAT_SDK_CHANNEL_ID` | unset                                                                                                                                                       | Slack bot. When unset, runs proceed silently (no notifications).                                                                 |
| `CHAT_SDK_BOT_NAME`                           | `blazebot`                                                                                                                                                  | Slack display name                                                                                                               |
| `SLACK_SIGNING_SECRET`                        | unset                                                                                                                                                       | Required only if you register the `/ai-workflow` slash command. When unset, `/webhooks/slack` rejects all requests.              |
| `SLACK_ALLOWED_USER_IDS`                      | empty (anyone)                                                                                                                                              | Comma-separated user IDs allowed to run slash commands                                                                           |
| `CRON_SECRET`                                 | unset                                                                                                                                                       | Generate: `openssl rand -hex 32`. Without it, `/cron/poll` accepts unauthenticated callers — strongly recommended in production. |
| `JIRA_WEBHOOK_SECRET`                         | unset                                                                                                                                                       | Generate: `openssl rand -hex 32`. Without it, dispatch is cron-bound (1-min latency).                                            |
| `CLAUDE_MODEL`                                | `claude-opus-4-6`                                                                                                                                           | Anthropic model                                                                                                                  |
| `CODEX_MODEL`                                 | `gpt-5-codex`                                                                                                                                               | Codex model                                                                                                                      |
| `MAX_CONCURRENT_AGENTS`                       | `3`                                                                                                                                                         | Parallel sandbox cap                                                                                                             |
| `JOB_TIMEOUT_MS`                              | `1800000` (30 min)                                                                                                                                          | Per-run timeout                                                                                                                  |
| `POLL_INTERVAL_MS`                            | `300000` (5 min)                                                                                                                                            | Internal poll cadence                                                                                                            |
| `COMMIT_AUTHOR`, `COMMIT_EMAIL`               | _unset_ on GitHub → auto-derived from the App (commits author as `<app-slug>[bot]`); GitLab falls back to `ai-workflow-blazity` / `ai-workflow@blazity.com` | Optional override; set both or neither                                                                                           |
| `DASHBOARD_ORG_NAME`, `DASHBOARD_ORG_SLUG`    | `AI Workflow`, `ai-workflow`                                                                                                                                | Fixed dashboard organization display name and slug. Override before first auth bootstrap only.                                    |
| `SSO_ISSUER`, `SSO_ALLOWED_DOMAIN`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` | unset | Optional SSO config. Set all four together, or leave all four unset for password-only login. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL`         | unset                                                                                                                                                       | Optional email delivery config. `RESEND_API_KEY` requires `RESEND_FROM_EMAIL`.                                                    |
| `RESEND_WEBHOOK_SECRET`                       | unset                                                                                                                                                       | Optional Resend webhook signing secret. Requires `RESEND_API_KEY`.                                                               |

`env.ts` cross-validates at startup — missing required vars or wrong combinations (e.g. `VCS_KIND=github` without `GITHUB_OWNER`) crash the process with a precise error.

---

## 6. Deploy to Vercel

Run these from `apps/worker` (the linked worker project). The dashboard deploys separately — see [Optional integrations → Dashboard](#dashboard-cockpit--observability-ui).

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

- HTTP routes from `apps/worker/src/routes/` — health, cron, webhooks, slash commands, and the read-only `/api/v1/*` API.
- Vercel Workflow definitions — workflow state is managed by Vercel in production (no Postgres needed).
- Cron job from `vercel.json` (`* * * * *` → `/cron/poll`) — activates automatically. Vercel injects the `CRON_SECRET` auth header.

---

## 7. Register the Jira webhook

Without this, ai-workflow only learns about ticket changes via the 1-minute cron poll.

1. Go to **Jira → System Settings → WebHooks** (admin only) or use the Atlassian REST API.
2. Create a webhook:
   - **URL:** `https://<your-vercel-domain>/webhooks/jira`
   - **Secret:** the `JIRA_WEBHOOK_SECRET` value from step 5. Jira signs each delivery with HMAC-SHA256 in the `X-Hub-Signature` header; the handler at `apps/worker/src/routes/webhooks/jira.post.ts` verifies it with `timingSafeEqual`.
   - **Events:** `jira:issue_updated` (required). Add `jira:issue_created` and `comment_created` if you want creates and comments to dispatch instantly.
   - **JQL filter** (optional): `project = AWT` to limit deliveries to the relevant project.
3. Save.

Verify by moving a test ticket into the AI column and watching the Vercel runtime logs.

---

## 8. Register the GitHub webhook (post-PR gate)

The post-PR gate runs configurable checks (e.g. PR title format) against every PR on the target repo and surfaces results as GitHub Check Runs on the head SHA. The webhook is what triggers it. See [`docs/post-pr-gate-spec.md`](./docs/post-pr-gate-spec.md) for the architecture.

If you followed [`docs/GITHUB-APP-SETUP.md`](./docs/GITHUB-APP-SETUP.md) in step 2.2, the App is already configured with the right webhook URL, secret, permissions, and event subscription. This section is the post-deploy verification — and the place to fix things if any of the above were skipped.

1. **Update the webhook URL** if you used a placeholder during App creation. In the App settings (`https://github.com/settings/apps/<your-app>` or via the org's developer settings), set **Webhook URL** to `https://<your-vercel-domain>/webhooks/github`.
2. **Confirm the App has the right permissions and event subscription:**
   - Repository permissions → **Checks: Read & write**
   - Subscribe to events → **Pull request** (checked)
3. **Re-accept on every installed repo** if you changed permissions or events after the initial install. A repo admin opens `https://github.com/organizations/<ORG>/settings/installations/<INSTALLATION_ID>` and clicks "Review request" → "Accept". Until accepted, the new permissions and events are inert and the gate webhook stays silent.
4. **Confirm `GITHUB_WEBHOOK_SECRET`** is set in Vercel (step 5) and matches the value pasted into the App's webhook config. A mismatch returns 401 on every delivery — visible in the App's **Advanced → Recent Deliveries** tab.
5. **Tune `post-pr-gate.yaml`** at the repo root if the defaults don't fit. The default config runs on `blazebot/*` branches only, skips drafts, and runs a single `pr-title-format` step (Conventional Commits) as advisory (`onFailure: continue`). Steps are defined in `apps/worker/src/post-pr-gate/steps/`.

For GitLab.com, configure the project webhook instead: see [`docs/GITLAB-SETUP.md`](./docs/GITLAB-SETUP.md). The webhook URL is `https://<your-vercel-domain>/webhooks/gitlab`, the secret token must match `GITLAB_WEBHOOK_SECRET`, and only **Merge request events** are required.

Verify by opening a manual PR titled `feat: smoke check` against the target repo (any `blazebot/*` branch — or set `botPrsOnly: false` in `post-pr-gate.yaml` to test from any branch). Within a few seconds you should see a `blazebot / pr-title-format` check run appear on the PR's head SHA and resolve to `success`.

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

The E2E jobs need the production env vars exposed as GitHub Actions secrets in the `e2e` environment (Repo Settings → Environments → e2e → Secrets). They additionally require `E2E_BASE_URL`, `E2E_GITHUB_APP_ID`, `E2E_GITHUB_APP_PRIVATE_KEY` (base64-encoded PEM), `E2E_GITHUB_INSTALLATION_ID`, `E2E_GITHUB_OWNER`, `E2E_GITHUB_REPO`, and `VERCEL_AUTOMATION_BYPASS_SECRET`.

---

## 12. Optional integrations

### Dashboard (cockpit — observability UI)

`apps/dashboard` is a separate Next.js app that renders the worker's runs, KPIs, and eval health. It's **read-only** and entirely optional — the bot runs without it. It holds no integration credentials; it just calls the worker's gated `/api/v1/*` API server-side. Deploy it as its **own Vercel project**:

1. Link the dashboard from its directory (sets Root Directory to `apps/dashboard`):

   ```bash
   cd apps/dashboard
   vercel link        # create/select a SECOND project (e.g. ai-workflow-dashboard)
   ```

2. Set its env var (`apps/dashboard/.env.example` documents it):

   | Variable           | Value                                                                                              |
   | ------------------ | -------------------------------------------------------------------------------------------------- |
   | `WORKER_BASE_URL`  | The deployed worker's base URL, no trailing slash (e.g. `https://<your-worker>.vercel.app`).       |

   ```bash
   vercel env add WORKER_BASE_URL production
   ```

3. Deploy:

   ```bash
   vercel --prod
   ```

The dashboard holds no worker secret. Human login is handled by the worker (Better Auth); the dashboard stores the worker-issued session token in a first-party `httpOnly` cookie and replays it server-side. Set `DASHBOARD_ORIGIN` on the **worker** to this dashboard's URL so Better Auth trusts it. Password-only mode needs no SSO vars; sign in at `/login` with `DASHBOARD_AUTH_EMAIL` / `DASHBOARD_AUTH_PASSWORD`. Optional SSO, Resend, and fixed organization vars belong on the worker project, not the dashboard project.

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

Flip `VCS_KIND=gitlab` and provide `GITLAB_TOKEN`, `GITLAB_PROJECT_ID`, and `GITLAB_WEBHOOK_SECRET`. For GitLab.com setup, see [`docs/GITLAB-SETUP.md`](./docs/GITLAB-SETUP.md). `GITHUB_*` vars become inert.

---

## 13. Troubleshooting

| Symptom                                               | Likely cause                                                                                                                            | Fix                                                                                                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup crash: `Invalid environment variables`        | Missing required var or wrong cross-field combination                                                                                   | Read the error — `env.ts` lists exactly what's missing.                                                                                                                 |
| `/cron/poll` returns 401 from Vercel Cron             | `CRON_SECRET` mismatch                                                                                                                  | Ensure the var is set in Production environment. Redeploy after changing.                                                                                               |
| Tickets in AI column never get picked up              | Cron disabled / webhook misregistered                                                                                                   | Check **Vercel → Project → Cron Jobs** is enabled. Curl `/cron/poll` with the secret to test manually.                                                                  |
| Workflow starts but sandbox fails to provision        | Missing Vercel OIDC / Sandbox quota                                                                                                     | On Vercel, OIDC is automatic. Check the project has Sandbox enabled (Pro plan). For local dev, set `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`.                 |
| Run registry: `DATABASE_URL undefined`                | Neon integration not connected to this project, or env var scoped to the wrong environments                                             | Reinstall the Neon integration / check it's connected to this project.                                                                                                  |
| Agent runs but PR isn't created                       | GitHub App missing **Pull requests: Read & write** or **Contents: Read & write**, App not installed on target repo, or wrong owner/repo | In the App settings, re-check **Repository permissions** and the **Installations** list. Verify `GITHUB_OWNER`/`GITHUB_REPO` point at the _target_ repo, not this repo. |
| Post-PR gate never runs on opened PRs                 | App webhook inactive, `Pull request` event not subscribed, missing `Checks: Read & write`, or permission/event change not re-accepted on the installed repo | App settings → **Webhook: Active** + URL set to `/webhooks/github`. Subscribe to **Pull request**. Bump **Checks** to read & write. Then have a repo admin re-accept the install at `https://github.com/organizations/<ORG>/settings/installations/<INSTALLATION_ID>`. Check **Advanced → Recent Deliveries** for 2xx responses. |
| Post-PR gate webhook returns 401 in Recent Deliveries | `GITHUB_WEBHOOK_SECRET` missing on the deployment or different from the value pasted into the App | Set the var on **every** environment (production + preview + development) — preview deployments receive the webhook too. Redeploy after changing. Test by re-sending a delivery from the App's Recent Deliveries tab. |
| Slack messages don't arrive                           | Bot not in channel, or wrong `CHAT_SDK_CHANNEL_ID`                                                                                      | Invite bot to the channel. Re-copy the channel ID.                                                                                                                      |
| Slash command returns `dispatch_failed`               | Signing secret wrong, or app not reinstalled                                                                                            | Verify `SLACK_SIGNING_SECRET`. Reinstall the Slack app after adding the slash command.                                                                                  |
| Two pollers race on the same ticket                   | Stale claim sentinel                                                                                                                    | The reconciler clears claims older than 5 minutes on every poll — wait one cycle, or run `pnpm exec tsx scripts/clear-run-registry.ts <ticket>` from `apps/worker` (after `vercel env pull .env.local`). |
| Sandbox times out                                     | Job too large for `JOB_TIMEOUT_MS`                                                                                                      | Increase to 60–90 minutes for complex tickets, or split the work.                                                                                                       |

### Useful logs

- **Vercel runtime logs:** `vercel logs <deployment-url>` or **Project → Logs**.
- **Workflow runs:** **Project → Workflows** in the Vercel dashboard — shows step-by-step state, failures, retries.
- **Local logs:** Pino prints structured JSON. Pipe through `pnpm dlx pino-pretty`.

---

## Reference

- Architecture and workflow internals → [README.md](./README.md)
- Spec → [docs/SPEC.md](./docs/SPEC.md)
- User stories → [docs/user-stories.md](./docs/user-stories.md)
- Per-integration walkthroughs → `.claude/skills/init-*/` (Jira, Slack, Neon, VCS, agent runtime)
