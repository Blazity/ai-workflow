# Blazebot

A workflow-driven AI coding automation service that turns Jira tickets into merge-ready pull requests. Blazebot polls your issue tracker for tickets assigned to AI, implements features end-to-end inside isolated [Vercel Sandboxes](https://vercel.com/docs/sandbox), and delivers PRs for human approval — no manual intervention required.

Designed for **self-hosting**: bring your own API keys (Jira, GitHub, Slack, Anthropic) and run on your own Vercel infrastructure.

## How It Works

1. **You move a Jira ticket** to the "AI" column on your board
2. **Blazebot's poller** discovers the ticket (runs every minute via Vercel Cron)
3. **A durable Vercel Workflow** orchestrates the full implementation lifecycle
4. **Claude Code** runs inside an isolated Vercel Sandbox — one sandbox per ticket, no access to production
5. **A pull request is created**, the ticket moves to "AI Review", and your team gets a Slack notification

If the PR gets review feedback, Blazebot picks it up again, runs a fix cycle, and pushes updates. If the agent can't proceed without human input, it posts clarification questions on the ticket and waits.

```mermaid
flowchart TD
    A["Jira ticket moved to AI column"] --> B["Poller discovers ticket"]
    B --> C{"PR already exists?"}

    C -- No --> D["Implementation Workflow"]
    C -- Yes --> E["Review-Fix Workflow"]

    D --> F["Create feature branch"]
    F --> G["Provision Vercel Sandbox"]
    G --> H["Run Claude Code agent"]
    H --> I{Agent result?}

    I -- "implemented" --> J["Push changes & create PR"]
    J --> K["Move ticket to AI Review"]
    K --> L["Notify via Slack"]

    I -- "clarification_needed" --> M["Post questions on ticket"]
    M --> N["Move ticket to Backlog"]
    N --> O["Notify via Slack"]

    I -- "failed" --> P["Notify failure via Slack"]

    E --> Q["Fetch PR comments & conflict status"]
    Q --> G

    R["Reconciler runs on every poll"] -.-> S["Cleans finished runs"]
    R -.-> T["Cancels orphaned runs"]
```

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Server | [Nitropack](https://nitro.build) | HTTP server framework (Vercel Functions) |
| Orchestration | [Vercel Workflows](https://vercel.com/docs/workflow) | Durable execution — survives crashes and deploys |
| Agent Execution | [Vercel Sandbox](https://vercel.com/docs/sandbox) | Isolated per-ticket environments |
| AI Agent | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Coding agent (Anthropic) |
| Issue Tracker | Jira REST API | Ticket lifecycle management |
| VCS | GitHub ([Octokit](https://github.com/octokit/rest.js)) | Branches, PRs, file pushes |
| Messaging | [Chat SDK](https://chat-sdk.dev) + Slack | Team notifications |
| Run Registry | [Upstash Redis](https://upstash.com) via [Vercel KV](https://vercel.com/docs/storage/vercel-kv) | Atomic claim/release for concurrent runs |
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
git clone https://github.com/AmeliaBlaworiq/ai-workflow.git
cd ai-workflow
pnpm install
```

### 2. Link to Vercel

Blazebot runs on Vercel and uses OIDC for Sandbox authentication. Link the project first:

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
ISSUE_TRACKER_KIND=jira
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token    # Generate at https://id.atlassian.com/manage-profile/security/api-tokens
JIRA_PROJECT_KEY=PROJ                  # Your Jira project key (e.g., AWT)
```

**Jira columns** — The board column names Blazebot watches and moves tickets between:
```bash
COLUMN_AI=AI                # Column where tickets are assigned to the agent
COLUMN_AI_REVIEW=AI Review  # Column where completed tickets go for human review
COLUMN_BACKLOG=Backlog      # Column where tickets go when clarification is needed
```

**GitHub** — Repository where PRs will be created:
```bash
VCS_KIND=github
GITHUB_TOKEN=ghp_xxxxxxxxxxxx          # Personal access token with repo scope
GITHUB_OWNER=your-org                  # GitHub org or username
GITHUB_REPO=your-repo                  # Target repository name
GITHUB_BASE_BRANCH=main               # Branch PRs will target
```

**Slack** — Bot notifications and slash commands:
```bash
CHAT_SDK_SLACK_TOKEN=xoxb-xxxxxxxxxxxx  # Slack bot token (chat:write scope)
CHAT_SDK_CHANNEL_ID=C0123456789         # Channel ID for notifications
CHAT_SDK_BOT_NAME=blazebot             # Display name for the bot
SLACK_SIGNING_SECRET=xxxxxxxxxxxxxxxx   # Required for /ai-workflow slash commands
SLACK_ALLOWED_USER_IDS=U0123,U4567      # Optional: comma-separated allowlist
```

Operators can drive workflows directly from Slack with `/ai-workflow list | status <KEY> | cancel <KEY>` once `SLACK_SIGNING_SECRET` is set and the slash command is registered (Request URL: `https://<your-domain>/webhooks/slack`). See `.claude/skills/init-slack/references/slash-commands.md` for the full setup walkthrough.

**Agent** — AI model configuration:
```bash
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx  # Anthropic API key
CLAUDE_MODEL=claude-opus-4-6           # Model to use (default: claude-opus-4-6)
COMMIT_AUTHOR=ai-workflow-blazity      # Git commit author name
COMMIT_EMAIL=ai-workflow@blazity.com   # Git commit author email
```

**Switching agents** — Blazebot supports two CLI runtimes. Set `AGENT_KIND` once per deployment:

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
| `ISSUE_TRACKER_KIND` | Yes | — | Issue tracker type (`jira`) |
| `JIRA_BASE_URL` | Yes | — | Atlassian instance URL |
| `JIRA_EMAIL` | Yes | — | Jira account email |
| `JIRA_API_TOKEN` | Yes | — | Jira API token |
| `JIRA_PROJECT_KEY` | Yes | — | Jira project key |
| `COLUMN_AI` | Yes | — | Board column for AI-assigned tickets |
| `COLUMN_AI_REVIEW` | Yes | — | Board column for completed tickets |
| `COLUMN_BACKLOG` | Yes | — | Board column for tickets needing clarification |
| **GitHub** | | | |
| `VCS_KIND` | Yes | — | VCS provider (`github`) |
| `GITHUB_TOKEN` | Yes | — | GitHub PAT with repo scope |
| `GITHUB_OWNER` | Yes | — | GitHub org or username |
| `GITHUB_REPO` | Yes | — | Target repository |
| `GITHUB_BASE_BRANCH` | No | `main` | Base branch for PRs |
| **Slack** | | | |
| `CHAT_SDK_SLACK_TOKEN` | Yes | — | Slack bot token |
| `CHAT_SDK_CHANNEL_ID` | Yes | — | Notification channel ID |
| `CHAT_SDK_BOT_NAME` | No | `blazebot` | Bot display name |
| `SLACK_SIGNING_SECRET` | Yes | — | Slack app signing secret; verifies `/ai-workflow` slash commands |
| `SLACK_ALLOWED_USER_IDS` | No | — | Comma-separated Slack user IDs allowed to run `/ai-workflow`; empty = anyone |
| **Agent** | | | |
| `AGENT_KIND` | No | `claude` | Runtime: `claude` or `codex` |
| `ANTHROPIC_API_KEY` | Yes* | — | Anthropic API key (required when `AGENT_KIND=claude`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | — | Alternative to `ANTHROPIC_API_KEY` |
| `CLAUDE_MODEL` | No | `claude-opus-4-6` | Claude model ID |
| `CODEX_API_KEY` | Yes* | — | OpenAI Codex API key (required when `AGENT_KIND=codex`) |
| `CODEX_CHATGPT_OAUTH_TOKEN` | No | — | Alternative to `CODEX_API_KEY` |
| `CODEX_MODEL` | No | `gpt-5-codex` | Codex model ID |
| `CODEX_PRICING_URL` | No | LiteLLM JSON | Pricing source for Codex cost reporting |
| `CODEX_PRICING_TTL_MS` | No | `3600000` | Pricing cache TTL (ms) |
| `COMMIT_AUTHOR` | No | `ai-workflow-blazity` | Git author name |
| `COMMIT_EMAIL` | No | `ai-workflow@blazity.com` | Git author email |
| **Sandbox** | | | |
| `MAX_CONCURRENT_AGENTS` | No | `3` | Max parallel sandboxes |
| `JOB_TIMEOUT_MS` | No | `1800000` | Agent timeout (ms) |
| **Polling** | | | |
| `POLL_INTERVAL_MS` | No | `300000` | Poll interval (ms) |
| **Vercel** | | | |
| `VERCEL_TOKEN` | No* | — | Vercel API token (local dev only) |
| `VERCEL_TEAM_ID` | No* | — | Vercel team ID (local dev only) |
| `VERCEL_PROJECT_ID` | No* | — | Vercel project ID (local dev only) |
| **Redis** | | | |
| `AI_WORKFLOW_KV_REST_API_URL` | Yes | — | Upstash Redis REST URL |
| `AI_WORKFLOW_KV_REST_API_TOKEN` | Yes | — | Upstash Redis REST token |
| **Security** | | | |
| `CRON_SECRET` | No | — | Cron endpoint auth token |
\* On Vercel, OIDC authenticates automatically. These are only needed for local development if `vercel env pull` doesn't cover your setup.

## Deploying to Vercel

### 1. Push to GitHub

Blazebot deploys automatically when connected to Vercel via Git integration.

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

- **CI** (`ci.yml`) — Runs on every push to `main`/`dev` and on pull requests. Runs typecheck and unit tests.
- **E2E** (`e2e.yml`) — Manual trigger with tier selection:
  - **Tier 1** — Basic integration tests (15 min timeout)
  - **Tier 2** — Full end-to-end with real Jira/GitHub (150 min timeout, requires Tier 1 to pass first)

## Workflow Deep-dive

### Implementation Workflow

When a ticket is discovered in the AI column and no PR exists yet, the **implementation workflow** runs:

| Step | What happens |
|------|-------------|
| `fetchAndValidateTicket` | Fetches ticket from Jira, verifies it's still in the AI column |
| `createFeatureBranch` | Creates `blazebot/{ticket-key}` branch from the base branch |
| `assembleImplementationRequirements` | Combines ticket title, description, acceptance criteria, and comments into a `requirements.md` prompt |
| `provisionAndStartAgent` | Provisions a Vercel Sandbox, installs Claude Code + global skills, starts the agent detached with a JSON output schema |
| *poll loop* | Polls the sandbox every 30s for completion (workflow suspends between polls) |
| `collectAgentResults` | Reads agent output and extracts changed files from the sandbox |
| `pushChanges` | Pushes all modified files to the feature branch via the GitHub API |
| `createPullRequest` | Opens a PR targeting the base branch |
| `moveTicket` | Moves the Jira ticket to the "AI Review" column |
| `notifySlack` | Sends a Slack message to the configured channel |
| `unregisterRun` | Removes the ticket from the run registry |

If the agent returns `clarification_needed`, the workflow instead posts the questions as a Jira comment, moves the ticket to Backlog, and notifies via Slack. When someone answers and moves the ticket back to AI, Blazebot picks it up again with the full conversation history.

### Review-Fix Workflow

When a ticket is in the AI column but a PR already exists (indicating review feedback), the **review-fix workflow** runs:

| Step | What happens |
|------|-------------|
| `fetchAndValidateTicket` | Same as implementation |
| `fetchPRContext` | Fetches all PR comments (review + issue) and merge conflict status |
| `assembleReviewFixRequirements` | Builds requirements including the original ticket context plus PR feedback and conflict status |
| `provisionAndStartFixingAgent` | Starts the agent detached with the fixing prompt |
| *poll loop* | Polls the sandbox every 30s for completion |
| `collectAgentResults` | Reads agent output and extracts changed files |
| `pushChanges` | Pushes fixes to the existing branch |
| `moveTicket` | Moves back to AI Review |
| `notifySlack` | Notifies the team |
| `unregisterRun` | Cleans up |

### Sandbox Lifecycle

Each agent run gets a fresh, isolated [Vercel Sandbox](https://vercel.com/docs/sandbox) — a Firecracker microVM with no access to production infrastructure or other tickets.

#### What gets passed into the sandbox

| Input | How it's provided |
|-------|-------------------|
| Repository source code | Cloned via `git` source at the feature branch (shallow clone, `depth=1`) |
| `ANTHROPIC_API_KEY` | Injected as an environment variable |
| `CLAUDE_MODEL` | Injected as an environment variable |
| `requirements.md` | Written to the sandbox root via `sandbox.writeFiles()` — contains ticket title, description, acceptance criteria, comments, and the agent prompt |
| Git identity | Configured inside the sandbox (`git config user.name` / `user.email`) |
| Claude Code | Installed globally via `npm i -g @anthropic-ai/claude-code` |
| Skills | Installed globally to `~/.claude/skills/` (not in the repo) — includes `using-superpowers`, `requesting-code-review`, and `frontend-design` |

The sandbox runs on **Node.js 24** with a configurable timeout (`JOB_TIMEOUT_MS`, default 30 minutes). On Vercel, OIDC authenticates the sandbox automatically. For local dev, explicit `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` are needed.

#### How the agent runs

Claude Code is invoked inside the sandbox with:
- `--dangerously-skip-permissions` — safe because the sandbox is fully isolated
- `--output-format json` — enforces structured output
- `--json-schema '{...}'` — the agent must return output matching the schema below

The agent reads `requirements.md` via stdin and implements the feature autonomously. It has access to the full repository, can run tests, install dependencies, and make commits.

The agent must return structured output conforming to:

```json
{
  "result": "implemented | clarification_needed | failed",
  "summary": "What was done",
  "questions": ["Question 1", "Question 2"],
  "error": "What went wrong"
}
```

#### How commits are extracted

The agent commits inside the sandbox via a **stop hook** that blocks exit until all changes are committed. A **wrapper script** runs the agent detached, cleans up artifacts (`.claude/`, `requirements.md`), and writes a sentinel file (`/tmp/agent-done`) on completion. The workflow polls for this sentinel every 30 seconds, then:

1. Reads agent stdout/stderr from `/tmp/agent-stdout.txt` and `/tmp/agent-stderr.txt`
2. Diffs against the pre-agent SHA to find changed files (`git diff --name-only`)
3. Reads each modified file's content from the sandbox (excluding `requirements.md` and `.claude/`)
4. Returns the file list `Array<{ path, content }>` to the workflow

#### How changes get pushed to GitHub

Blazebot does **not** push from inside the sandbox. Instead, the extracted files are pushed via the **GitHub Git Data API** (Octokit), which builds a commit from the outside:

1. **Create blobs** — each file's content is uploaded as a base64-encoded blob
2. **Create tree** — a new Git tree is assembled referencing all blobs, based on the branch's current tree
3. **Create commit** — a new commit object is created with the tree and the branch tip as parent
4. **Update ref** — the branch ref (`refs/heads/blazebot/{ticket-key}`) is fast-forwarded to the new commit

This approach avoids giving the sandbox push credentials to the target repository.

#### How PRs are created

After pushing, the workflow calls `octokit.pulls.create()` to open a PR:
- **Head**: the feature branch (`blazebot/{ticket-key}`)
- **Base**: the configured base branch (default `main`)
- **Title and body**: generated from the ticket title and the agent's summary

For the review-fix workflow, no new PR is created — the existing PR is updated by pushing to the same branch.

#### Teardown

The sandbox is **always destroyed** after each run (in a `finally` block), whether the agent succeeded, failed, or timed out. Every run starts and ends with a clean slate.

### Run Registry and Reconciliation

Blazebot uses an **atomic claim pattern** via Upstash Redis to prevent duplicate runs:

- When a ticket is dispatched, a `claiming:{timestamp}` sentinel is set atomically (`hsetnx`)
- Only one poller instance can win the claim — others see it's taken
- After the workflow starts, the sentinel is replaced with the real workflow run ID
- On every poll cycle, the **reconciler** cleans up:
  - Stale claims older than 5 minutes
  - Finished runs still tracked in the registry
  - Orphaned runs for tickets that left the AI column (cancels the workflow)

## License

MIT
