# ai workflow

A workflow-driven AI coding automation service that turns Jira tickets into merge-ready pull requests. ai workflow polls your issue tracker for tickets assigned to AI, implements features end-to-end inside isolated [Vercel Sandboxes](https://vercel.com/docs/sandbox), and delivers PRs for human approval — no manual intervention required.

Designed to work with **Vercel infrastructure**: bring your own API keys (Jira, GitHub, Slack, Anthropic) and deploy onto Vercel — Functions for the HTTP server, Workflows for durable orchestration, and Sandboxes for isolated agent execution.

## How It Works

1. **You move a Jira ticket** to the "AI" column on your board
2. **ai workflow dispatches** the ticket — instantly via the Jira webhook, or within ~1 min via the Vercel Cron poller as a fallback
3. **A durable Vercel Workflow** runs the agent in phases (research → implementation) inside a single Vercel Sandbox per ticket
4. **The sandbox pushes commits** directly to the feature branch, the ticket moves to "AI Review", and your team gets a Slack notification

If the ticket already has an open PR (review feedback), the same workflow re-runs and feeds the PR comments + conflict status into the agent's context. If the agent can't proceed without human input, it posts clarification questions on the ticket and moves it to Backlog.

```mermaid
flowchart TD
    A["Jira ticket moved to AI column"] --> B{"Dispatch"}
    B -- "webhook (instant)" --> D["agentWorkflow"]
    B -- "cron poll (~1 min)" --> D

    D --> E["fetchPRContext (existing PR?)"]
    E --> F["createFeatureBranch (only if no PR)"]
    F --> G["provisionSandbox + register sandbox"]

    G --> P1["Phase 1: Research / Plan"]
    P1 --> P1R{Research result?}
    P1R -- "clarification_needed" --> CL["Post questions → Backlog → notify"]
    P1R -- "failed / timeout" --> FB["Move to Backlog → notify failed"]
    P1R -- "completed" --> P2["Phase 2: Implementation"]

    P2 --> P2R{Impl result?}
    P2R -- "clarification_needed" --> CL
    P2R -- "failed / timeout" --> FB
    P2R -- "implemented" --> PUSH["pushFromSandbox (git push --force from inside sandbox)"]

    PUSH --> PUSHR{Push ok?}
    PUSHR -- "no" --> FIX["fixAndRetryPush (lightweight fix agent)"]
    FIX --> PUSHR
    PUSHR -- "yes" --> PR["createPullRequest / findPR"]
    PR --> MV["Move to AI Review → notify pr_ready"]

    TD["teardownSandbox (always runs in finally)"]
    MV -.-> TD
    CL -.-> TD
    FB -.-> TD

    R["Reconciler (every poll)"] -.-> R1["Stale claims (>5 min)"]
    R -.-> R2["Finished runs"]
    R -.-> R3["Orphaned runs (ticket left AI column)"]
    R -.-> R4["Stale failed-ticket markers"]
```

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Server | [Nitropack](https://nitro.build) | HTTP server framework (Vercel Functions) |
| Orchestration | [Vercel Workflows](https://vercel.com/docs/workflow) | Durable execution — survives crashes and deploys |
| Agent Execution | [Vercel Sandbox](https://vercel.com/docs/sandbox) | Isolated per-ticket environments |
| AI Agent | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [OpenAI Codex CLI](https://github.com/openai/codex) | Coding agent (selectable via `AGENT_KIND`) |
| Issue Tracker | Jira REST API | Ticket lifecycle management |
| VCS | GitHub ([Octokit](https://github.com/octokit/rest.js)) or GitLab ([@gitbeaker/rest](https://github.com/jdalrymple/gitbeaker)) | Branches, PRs/MRs, comments |
| Messaging | [Chat SDK](https://chat-sdk.dev) + Slack | Team notifications + `/ai-workflow` slash commands |
| Run Registry | [Upstash Redis](https://upstash.com) (via Vercel Marketplace integration) | Atomic claim/release for concurrent runs |
| Tracing (optional) | [Arthur AI Engine](https://www.arthur.ai/) | Per-run prompt/tool tracing inside the sandbox |
| Validation | [Zod](https://zod.dev) | Schema validation for config and agent output |
| Logging | [Pino](https://getpino.io) | Structured JSON logs |
| Testing | [Vitest](https://vitest.dev) | Unit and E2E tests |

## Getting Started

### Prerequisites

- **Node.js** 20+
- **pnpm** 10+
- **Vercel CLI** — `npm i -g vercel@latest`
- **Accounts** — you'll need credentials for:
  - [Jira](https://www.atlassian.com/software/jira) (API token)
  - [GitHub](https://github.com) (personal access token with repo scope)
  - [Slack](https://slack.com) (bot token with `chat:write` scope)
  - [Anthropic](https://console.anthropic.com) (API key)
  - [Upstash](https://upstash.com) (Redis database)

### 1. Clone and install

```bash
git clone https://github.com/Blazity/ai-workflow.git
cd ai-workflow
pnpm install
```

### 2. Link to Vercel

ai workflow runs on Vercel and uses OIDC for Sandbox authentication. Link the project first:

```bash
vercel link
```

Follow the prompts to connect to your Vercel team and project.

### 3. Configure environment variables

Copy the example file and fill in your credentials:

```bash
cp .env.example .env
```

Walk through each section:

**Jira** — Your Atlassian instance and API credentials:
```bash
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token    # Generate at https://id.atlassian.com/manage-profile/security/api-tokens
JIRA_PROJECT_KEY=PROJ                  # Your Jira project key (e.g., AWT)
JIRA_WEBHOOK_SECRET=                   # Optional: openssl rand -hex 32. Without it, dispatch falls back to 1-min cron polling.
```

> The Jira webhook is registered separately (see [SETUP.md § 8](./SETUP.md#8-register-the-jira-webhook)). The handler at `/webhooks/jira` verifies an `X-Hub-Signature` HMAC-SHA256 header.

**Jira columns** — The board column names ai workflow watches and moves tickets between:
```bash
COLUMN_AI=AI                # Column where tickets are assigned to the agent
COLUMN_AI_REVIEW=AI Review  # Column where completed tickets go for human review
COLUMN_BACKLOG=Backlog      # Column where tickets go when clarification is needed
```

**VCS** — Choose `github` or `gitlab`. Only fill the block matching your provider.

```bash
VCS_KIND=github

# GitHub (active when VCS_KIND=github)
GITHUB_TOKEN=ghp_xxxxxxxxxxxx          # Personal access token with repo scope
GITHUB_OWNER=your-org                  # GitHub org or username
GITHUB_REPO=your-repo                  # Target repository name
GITHUB_BASE_BRANCH=main                # Branch PRs will target
```

```bash
VCS_KIND=gitlab

# GitLab (active when VCS_KIND=gitlab)
GITLAB_TOKEN=glpat-xxxxxxxxxxxx        # PAT with api, read_repository, write_repository scopes
GITLAB_PROJECT_ID=group/repo           # Project ID or full path
GITLAB_BASE_BRANCH=main                # Branch PRs will target
GITLAB_HOST=https://gitlab.com         # Override for self-hosted
```

**Slack** — Bot notifications and slash commands. Bot scopes: `chat:write`, `commands`, `files:read`, `users:read`.
```bash
CHAT_SDK_SLACK_TOKEN=xoxb-xxxxxxxxxxxx  # Slack bot token
CHAT_SDK_CHANNEL_ID=C0123456789         # Channel ID for notifications
CHAT_SDK_BOT_NAME=blazebot             # Display name for the bot
SLACK_SIGNING_SECRET=xxxxxxxxxxxxxxxx   # Required — verifies /ai-workflow slash commands
SLACK_ALLOWED_USER_IDS=U0123,U4567      # Optional: comma-separated allowlist
```

Operators can drive workflows directly from Slack with `/ai-workflow list | status <KEY> | cancel <KEY>` once `SLACK_SIGNING_SECRET` is set and the slash command is registered (Request URL: `https://<your-domain>/webhooks/slack`). See `.claude/skills/init-slack/references/slash-commands.md` for the full setup walkthrough.

**Agent** — AI model configuration:
```bash
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx  # Anthropic API key
CLAUDE_MODEL=claude-opus-4-6           # Model to use (default: claude-opus-4-6)
# COMMIT_AUTHOR=                       # Optional override (set with COMMIT_EMAIL).
# COMMIT_EMAIL=                        # On GitHub, leave unset to author commits as the App's bot.
```

**GitHub App bot identity** — when `VCS_KIND=github` and both `COMMIT_AUTHOR` / `COMMIT_EMAIL` are unset, the workflow derives the identity from the configured GitHub App (`<app-slug>[bot]` + the `<id>+<slug>[bot]@users.noreply.github.com` noreply address). GitHub then renders commits with the App's avatar and the `[bot]` badge in the UI.

**Switching agents** — ai workflow supports two CLI runtimes. Set `AGENT_KIND` once per deployment:

```bash
AGENT_KIND=claude    # default — Anthropic Claude Code
# or
AGENT_KIND=codex     # OpenAI Codex CLI
```

When `AGENT_KIND=codex`:

```bash
CODEX_API_KEY=sk-codex-xxxxxxxxxxxx   # or CODEX_CHATGPT_OAUTH_TOKEN
CODEX_MODEL=gpt-5-codex                # default
```

Pricing is fetched from [LiteLLM's community-maintained JSON](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) on each cold start (1h TTL by default). Override `CODEX_PRICING_URL` in air-gapped environments. When pricing is unavailable, Slack reports show tokens-only with `cost unknown`.

**Sandbox** — Concurrency and timeout limits:
```bash
MAX_CONCURRENT_AGENTS=3   # Max parallel sandboxes (default: 3)
JOB_TIMEOUT_MS=1800000    # Agent timeout in ms (default: 30 minutes)
```

**Run Registry** — Upstash Redis for tracking active runs:
```bash
AI_WORKFLOW_KV_REST_API_URL=https://your-redis.upstash.io
AI_WORKFLOW_KV_REST_API_TOKEN=your-upstash-token
```

**Security** — Cron endpoint authorization:
```bash
CRON_SECRET=your-secret   # Vercel Cron uses this to authenticate requests
```

### 4. Set up local Postgres (for workflow state in dev)

Vercel Workflows needs a Postgres database locally. Create one and set the connection string:

```bash
WORKFLOW_POSTGRES_URL=postgresql://localhost:5432/ai_workflow
```

### 5. Pull Vercel environment (optional)

If your Vercel project already has environment variables configured:

```bash
vercel env pull .env.local
```

This provisions OIDC tokens for Sandbox authentication automatically — no need to set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, or `VERCEL_PROJECT_ID` manually.

### 6. Run locally

```bash
pnpm dev
```

### 7. Verify it works

Check the health endpoint:

```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"2026-03-30T12:00:00.000Z"}
```

Trigger a poll manually (requires `CRON_SECRET`):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/cron/poll
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| **Jira** | | | |
| `ISSUE_TRACKER_KIND` | No | `jira` | Issue tracker type (only `jira` supported today) |
| `JIRA_BASE_URL` | Yes | — | Atlassian instance URL |
| `JIRA_EMAIL` | Yes | — | Jira account email |
| `JIRA_API_TOKEN` | Yes | — | Jira API token |
| `JIRA_PROJECT_KEY` | Yes | — | Jira project key |
| `JIRA_WEBHOOK_SECRET` | No | — | HMAC secret for `/webhooks/jira`. Without it, dispatch is cron-bound. |
| `COLUMN_AI` | Yes | — | Board column for AI-assigned tickets |
| `COLUMN_AI_REVIEW` | Yes | — | Board column for completed tickets |
| `COLUMN_BACKLOG` | Yes | — | Board column for tickets needing clarification |
| **VCS** | | | |
| `VCS_KIND` | Yes | — | `github` or `gitlab` |
| `GITHUB_TOKEN` | Yes† | — | GitHub PAT with `repo` scope (when `VCS_KIND=github`) |
| `GITHUB_OWNER` | Yes† | — | GitHub org or username (when `VCS_KIND=github`) |
| `GITHUB_REPO` | Yes† | — | Target repository (when `VCS_KIND=github`) |
| `GITHUB_BASE_BRANCH` | No | `main` | Base branch for PRs |
| `GITLAB_TOKEN` | Yes† | — | GitLab PAT with `api`, `read_repository`, `write_repository` (when `VCS_KIND=gitlab`) |
| `GITLAB_PROJECT_ID` | Yes† | — | Project ID or `group/repo` path (when `VCS_KIND=gitlab`) |
| `GITLAB_BASE_BRANCH` | No | `main` | Base branch for MRs |
| `GITLAB_HOST` | No | `https://gitlab.com` | Override for self-hosted GitLab |
| **Slack** | | | |
| `CHAT_SDK_SLACK_TOKEN` | Yes | — | Slack bot token |
| `CHAT_SDK_CHANNEL_ID` | Yes | — | Notification channel ID |
| `CHAT_SDK_BOT_NAME` | No | `blazebot` | Bot display name |
| `SLACK_SIGNING_SECRET` | Yes | — | Slack app signing secret; verifies `/ai-workflow` slash commands |
| `SLACK_ALLOWED_USER_IDS` | No | — | Comma-separated Slack user IDs allowed to run `/ai-workflow`; empty = anyone |
| **Agent** | | | |
| `AGENT_KIND` | No | `claude` | Runtime: `claude` or `codex` |
| `ANTHROPIC_API_KEY` | Yes‡ | — | Anthropic API key (required when `AGENT_KIND=claude`) |
| `CLAUDE_MODEL` | No | `claude-opus-4-6` | Claude model ID |
| `CODEX_API_KEY` | Yes‡ | — | OpenAI Codex API key (required when `AGENT_KIND=codex`) |
| `CODEX_CHATGPT_OAUTH_TOKEN` | No | — | Alternative to `CODEX_API_KEY` |
| `CODEX_MODEL` | No | `gpt-5-codex` | Codex model ID |
| `CODEX_PRICING_URL` | No | LiteLLM JSON | Pricing source for Codex cost reporting |
| `CODEX_PRICING_TTL_MS` | No | `3600000` | Pricing cache TTL (ms) |
| `COMMIT_AUTHOR` | No | _GitHub: App bot / GitLab: `ai-workflow-blazity`_ | Git author name (override; pair with `COMMIT_EMAIL`) |
| `COMMIT_EMAIL` | No | _GitHub: App bot / GitLab: `ai-workflow@blazity.com`_ | Git author email (override; pair with `COMMIT_AUTHOR`) |
| **Sandbox** | | | |
| `MAX_CONCURRENT_AGENTS` | No | `3` | Max parallel sandboxes |
| `JOB_TIMEOUT_MS` | No | `1800000` | Agent timeout (ms) |
| **Attachments** | | | |
| `ATTACHMENT_MAX_FILE_SIZE_MB` | No | `25` | Per-file size limit |
| `ATTACHMENT_MAX_TOTAL_SIZE_MB` | No | `100` | Combined attachment size limit |
| `ATTACHMENT_MAX_COUNT` | No | `20` | Max attachments per ticket |
| `ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | No | `30000` | Download timeout per attachment |
| **Polling** | | | |
| `POLL_INTERVAL_MS` | No | `300000` | Internal poll cadence (ms) — separate from the 1-min Vercel cron |
| **Vercel** | | | |
| `VERCEL_TOKEN` | No* | — | Vercel API token (local dev only) |
| `VERCEL_TEAM_ID` | No* | — | Vercel team ID (local dev only) |
| `VERCEL_PROJECT_ID` | No* | — | Vercel project ID (local dev only) |
| `WORKFLOW_POSTGRES_URL` | No* | — | Local Postgres for Vercel Workflow durable state (dev only) |
| **Arthur (optional)** | | | |
| `GENAI_ENGINE_API_KEY` | No | — | Arthur AI Engine API key |
| `GENAI_ENGINE_TRACE_ENDPOINT` | No | — | Arthur trace endpoint URL |
| `GENAI_ENGINE_PROMPT_TASK_ID` | No | — | Hosted prompt task ID (set after `pnpm setup:arthur-prompts`) |
| **Redis** | | | |
| `AI_WORKFLOW_KV_REST_API_URL` | Yes | — | Upstash Redis REST URL (auto-injected by Marketplace integration) |
| `AI_WORKFLOW_KV_REST_API_TOKEN` | Yes | — | Upstash Redis REST token (auto-injected) |
| **Security** | | | |
| `CRON_SECRET` | No | — | Cron endpoint auth token (Vercel sets this automatically when defined) |

† Required only for the matching `VCS_KIND`. `env.ts` cross-validates at startup.
‡ Required only for the matching `AGENT_KIND` (the OAuth token alternative also satisfies this).
\* On Vercel, OIDC authenticates the sandbox automatically. These are only needed for local development if `vercel env pull` doesn't cover your setup.

## Deploying to Vercel

### 1. Push to GitHub

ai workflow deploys automatically when connected to Vercel via Git integration.

### 2. Import project

In the [Vercel Dashboard](https://vercel.com/new), import your repository. Vercel auto-detects Nitropack and configures the build.

### 3. Set environment variables

Add all required environment variables in your Vercel project settings under **Settings → Environment Variables**. You can also use the CLI:

```bash
vercel env add JIRA_BASE_URL
vercel env add JIRA_API_TOKEN
# ... repeat for each variable
```

### 4. Cron job

The cron schedule is configured in `vercel.json` and activates automatically on deploy:

```json
{
  "crons": [
    {
      "path": "/cron/poll",
      "schedule": "* * * * *"
    }
  ]
}
```

This hits `/cron/poll` every minute. Vercel injects the `CRON_SECRET` header automatically.

### 5. CI/CD

Two GitHub Actions workflows are included:

- **CI** (`ci.yml`) — Runs on pull requests targeting `main`/`dev` and on `merge_group` events. Runs typecheck and unit tests; gates the merge queue on `e2e-orchestration → e2e-capacity → e2e-agent`.
- **E2E** (`e2e.yml`) — Manual `workflow_dispatch` with tier selection (`orchestration`, `capacity`, `agent`, `all`) and an `agent` choice (`claude` | `codex`):
  - **orchestration** — dispatch / cron / webhook flows (60 min timeout)
  - **capacity** — concurrency, claim/release, reconciler (30 min timeout, runs after orchestration)
  - **agent** — full ticket → PR run against real Jira + GitHub (120 min timeout, runs after capacity)

## Workflow Deep-dive

### One workflow, two phases

There is a single durable workflow — `agentWorkflow` in [`src/workflows/agent.ts`](./src/workflows/agent.ts) — that handles both fresh tickets and review-fix re-runs. The branching happens at *context-assembly* time, not at the workflow level: if an open PR for `blazebot/{ticket-key}` already exists, its comments, check results, and conflict status are folded into the agent's input.

| Step | What happens |
|------|-------------|
| `fetchAndValidateTicket` | Fetches the ticket from Jira; aborts if it's no longer in the AI column |
| `fetchPRContext` | Looks up an open PR for `blazebot/{ticket-key}`; returns comments, check results, conflict status (or `null` for fresh tickets) |
| `createFeatureBranch` | Only when there's no existing PR — creates/resets `blazebot/{ticket-key}` from the base branch |
| `fetchAttachments` | Downloads ticket attachments (size/count limited by `ATTACHMENT_*` env vars) |
| `ensureArthurTaskForTicket` | Optional — creates an Arthur trace task when `GENAI_ENGINE_*` is configured |
| `resolveAgentKindOverride` | Per-ticket override via labels (e.g. `agent:codex`); falls back to `AGENT_KIND` |
| `provisionSandbox` | Provisions a Vercel Sandbox, installs the agent CLI + skills, configures auth + Arthur tracer |
| `registerTicketSandbox` | Pins the sandbox id to the ticket in Redis so cleanup paths can stop it by id |
| `writeAttachments` | Writes downloaded attachments under `/tmp/attachments/` inside the sandbox |
| **Phase 1 — Research/Plan** | `setCommitGuardStep(false)` → `planPhaseStep("research")` → `writeAndStartPhase` → `pollUntilDone` (20 min) → `collectPhase` → `parseResearchStep`. Result is `completed`, `clarification_needed`, or `failed` |
| **Phase 2 — Implementation** | `setCommitGuardStep(true)` → `planPhaseStep("impl", AGENT_SCHEMA)` → `writeAndStartPhase` → `pollUntilDone` (35 min) → `collectPhase` → `parseAgentOutputStep` |
| `pushFromSandbox` | Injects the VCS token into the sandbox's git remote (after the agent process is dead) and runs `git push --force` from inside the sandbox |
| `fixAndRetryPush` | Fallback: if the push is rejected (e.g. pre-receive hook), spawns a lightweight fix agent in the same sandbox, then retries the push once |
| `createPullRequest` / `findPRForBranch` | Opens a new PR (no prior PR) or re-fetches the existing PR (review-fix path) |
| `moveTicket` → `notifyTicket("pr_ready")` | Moves the ticket to "AI Review" and sends the Slack notification with the usage report |
| `unregisterRun` | Removes the ticket from the Redis run registry |
| `teardownSandbox` | Always runs in `finally` — destroys the sandbox regardless of outcome |

If either phase returns `clarification_needed`, the workflow posts numbered questions as a Jira comment, moves the ticket to Backlog, and emits a `needs_clarification` Slack event. If a phase fails or times out, the ticket is moved to Backlog with a `failed` event.

> A third "Review" phase exists as commented-out scaffolding in `agent.ts`. It's intentionally disabled today.

### Sandbox Lifecycle

Each agent run gets a fresh, isolated [Vercel Sandbox](https://vercel.com/docs/sandbox) — a Firecracker microVM with no access to production infrastructure or other tickets.

#### What gets passed into the sandbox

| Input | How it's provided |
|-------|-------------------|
| Repository source code | Cloned via `git` source at the feature branch (shallow `depth=1`); unshallowed before push if needed |
| Auth env vars | `ANTHROPIC_API_KEY` (Claude) or `CODEX_API_KEY` / `CODEX_CHATGPT_OAUTH_TOKEN` (Codex) — written to `/tmp/agent-env.sh` (mode 0600) and sourced by each phase script |
| Model | `CLAUDE_MODEL` or `CODEX_MODEL` baked into the phase wrapper script |
| Per-phase input | `/tmp/research-requirements.md` and `/tmp/impl-requirements.md` — assembled by `assembleResearchPlanContext` / `assembleImplementationContext` |
| Attachments | Written to `/tmp/attachments/<filename>` |
| Git identity | `git config user.name` / `user.email` from `COMMIT_AUTHOR` / `COMMIT_EMAIL` (or auto-derived from the GitHub App when unset) |
| Agent CLI | `@anthropic-ai/claude-code` (Claude) or `@openai/codex` (Codex), installed globally |
| Skills | Installed via `npx skills add ... -g --agent claude-code codex --copy` to **both** `~/.claude/skills/` and `~/.agents/skills/`. Currently only [`frontend-design`](https://github.com/anthropics/skills) is in `GLOBAL_SKILLS` |
| Arthur tracer (optional) | Python tracer + `~/.claude/arthur_config.json` + hook entries in `~/.claude/settings.json` |

The sandbox runs on **Node.js 24** with a configurable timeout (`JOB_TIMEOUT_MS`, default 30 minutes). On Vercel, OIDC authenticates the sandbox automatically. For local dev, explicit `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` are needed.

#### How the agent runs

Each phase has its own wrapper script (`/tmp/{phase}-wrapper.sh`) that sources `/tmp/agent-env.sh` and pipes the phase input into the agent CLI:

- **Claude** (`buildPhaseScript` in [`src/sandbox/agents/claude.ts`](./src/sandbox/agents/claude.ts)):
  ```
  cat /tmp/{phase}-requirements.md | claude \
    --print --model '<model>' --dangerously-skip-permissions --output-format json \
    [--json-schema '<AGENT_SCHEMA>'] \
    > /tmp/{phase}-stdout.txt 2>/tmp/{phase}-stderr.txt
  ```
- **Codex** (`buildPhaseScript` in [`src/sandbox/agents/codex.ts`](./src/sandbox/agents/codex.ts)) uses `codex exec --model … --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json` with `--output-schema` for structured output.

The script ends by writing a sentinel file (`/tmp/{phase}-done`). The workflow polls every 30 seconds via `checkPhaseDone` and suspends between polls — durable across redeploys.

The implementation phase enforces the structured contract:

```json
{
  "result": "implemented | clarification_needed | failed",
  "summary": "What was done",
  "questions": ["Question 1", "Question 2"],
  "error": "What went wrong"
}
```

A **commit-guard stop hook** (toggled per phase via `setCommitGuardStep`) blocks the agent from exiting with uncommitted changes. Phase 1 has it disabled (research only — no commits expected); phase 2 enables it so the implementation phase can't return `result: "implemented"` while leaving the working tree dirty.

#### How changes get pushed

ai workflow pushes from **inside the sandbox**, but only after the agent process has exited. The flow in [`src/sandbox/poll-agent.ts`](./src/sandbox/poll-agent.ts):

1. **Verify commits exist** — compare the saved `/tmp/.pre-agent-sha` to the current `HEAD`. If unchanged, the workflow fails the run with "Agent reported success but made no commits."
2. **Inject the token** — `git remote set-url origin <auth-url>`. The agent process is already dead at this point and never sees the token.
3. **Unshallow if needed** — shallow clones miss shared ancestry with `main`, which breaks PR creation.
4. **Push** — `git push --force origin HEAD:refs/heads/{branch}` (force-push is safe; `blazebot/*` branches have no concurrent pushers).

If the push is rejected (e.g. by a remote pre-receive hook), `fixAndRetryPush` strips the token, spawns a smaller fix agent in the same sandbox with the push error as context, lets it commit fixes, then re-injects the token and retries the push once.

#### How PRs are created

For fresh tickets, the workflow opens a PR via the VCS adapter (`octokit.pulls.create()` for GitHub, `@gitbeaker/rest` for GitLab):
- **Head**: `blazebot/{ticket-key}`
- **Base**: `GITHUB_BASE_BRANCH` / `GITLAB_BASE_BRANCH` (default `main`)
- **Title**: the ticket title

For tickets that already had a PR (the review-fix path), no new PR is created — the existing PR is updated by the force-push and re-fetched via `findPRForBranch`.

#### Teardown

The sandbox is **always destroyed** after each run (in a `finally` block), whether the agent succeeded, failed, or timed out. Every run starts and ends with a clean slate.

### Run Registry and Reconciliation

ai workflow uses an **atomic claim pattern** via Upstash Redis to prevent duplicate runs:

- When a ticket is dispatched, a `claiming:{timestamp}` sentinel is set atomically (`hsetnx`)
- Only one poller instance can win the claim — others see it's taken
- After the workflow starts, the sentinel is replaced with the real workflow run ID and the sandbox id is pinned to the ticket
- On every poll cycle, the **reconciler** ([`src/lib/reconcile.ts`](./src/lib/reconcile.ts)) cleans up:
  - Stale claims older than 5 minutes (kills any orphaned sandbox + clears the sentinel)
  - Finished runs still tracked in the registry (status `completed` / `failed` / `cancelled`)
  - Orphaned runs for tickets that left the AI column — cancels the workflow and stops the sandbox
  - Stale failed-ticket markers (cleared once the ticket leaves the AI column)
  - A 30-second grace window guards against Jira's JQL index lag during column transitions

## License

MIT
