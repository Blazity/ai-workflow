# Blazebot

Queue-driven automation service that picks up tickets from an issue tracker, implements features inside isolated Docker containers using AI coding agents, and delivers merge-ready pull requests for human approval.

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 10
- **Docker** (for sandbox containers)
- **PostgreSQL** 16+
- **Redis** 7+

## Quick Start

### 1. Start infrastructure

```bash
docker compose up -d
```

This starts Postgres and Redis with default credentials (`blazebot`/`blazebot`).

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values (see [Environment Variables](#environment-variables) below).

### 4. Run database migrations

```bash
pnpm db:push
```

### 5. Build the sandbox image

```bash
docker build -t blazebot-sandbox docker/sandbox/
```

### 6. Start the service

```bash
# Development (auto-reload)
pnpm dev

# Production
pnpm build
pnpm start
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start in development mode with auto-reload |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run compiled production build |
| `pnpm test` | Run tests in watch mode |
| `pnpm db:generate` | Generate Drizzle migration files |
| `pnpm db:migrate` | Run pending migrations |
| `pnpm db:push` | Push schema directly to database (dev) |
| `pnpm inspect` | Attach to a running sandbox container's live logs (requires `DEVELOPER_MODE=true`) |

## Environment Variables

### Required

These must be set or the service will fail to start.

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string (e.g. `postgresql://blazebot:blazebot@localhost:5432/blazebot`) |
| `REDIS_URL` | Redis connection string (e.g. `redis://localhost:6379`) |
| `JIRA_WEBHOOK_SECRET` | HMAC secret for verifying Jira webhook `X-Hub-Signature` header |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token — generate with `claude setup-token` |

### Jira (required for worker)

| Variable | Description |
|----------|-------------|
| `JIRA_BASE_URL` | Jira instance URL (e.g. `https://yourteam.atlassian.net`) |
| `JIRA_USER_EMAIL` | Jira service account email |
| `JIRA_API_TOKEN` | Jira API token for the service account |
| `JIRA_PROJECT_KEY` | Jira project key for JQL queries (e.g. `PROJ`) |

### GitHub (required for worker)

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub personal access token with repo permissions |
| `GITHUB_REPO_OWNER` | Repository owner (e.g. `blazity`) |
| `GITHUB_REPO_NAME` | Repository name (e.g. `my-project`) |
| `GITHUB_BASE_BRANCH` | Base branch for PRs (default: `main`) |

### Slack (optional)

If omitted, no notifications are sent. The service runs normally without Slack.

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (starts with `xoxb-`) |
| `SLACK_DEFAULT_CHANNEL` | Channel for notifications (e.g. `#blazebot-notifications`) |

### Tuning

All of these have sensible defaults and are optional.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `MAX_CONCURRENT_AGENTS` | `3` | Maximum sandbox containers running in parallel |
| `JOB_TIMEOUT_MS` | `600000` | Agent timeout per run (10 minutes) |
| `JOB_MAX_RETRIES` | `3` | Number of retries before a job is marked as failed |
| `JOB_BACKOFF_MS` | `30000` | Base delay for exponential backoff between retries |
| `DOCKER_IMAGE` | `blazebot-sandbox` | Docker image for sandbox containers |
| `SANDBOX_MEMORY_MB` | `4096` | Memory limit per sandbox container |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | AI model for agent runs |
| `DEVELOPER_MODE` | `false` | Stream live agent output for `docker logs` inspection |
| `POLL_INTERVAL_MS` | `300000` | Maintenance poll interval (5 minutes) |
| `STUCK_JOB_THRESHOLD_MS` | `1200000` | Time before a job is considered stuck (20 minutes) |

### Column Mapping

Map your Jira board column names. Defaults match a standard Jira board.

| Variable | Default | Description |
|----------|---------|-------------|
| `COLUMN_AI` | `AI` | Column that triggers Blazebot to pick up a ticket |
| `COLUMN_AI_REVIEW` | `AI Review` | Column tickets move to when PR is ready |
| `COLUMN_BACKLOG` | `Backlog` | Column tickets move to when clarification is needed |

## Jira Webhook Setup

1. Go to **Jira Settings > System > WebHooks**
2. Create a webhook pointing to `https://your-host/webhooks/jira`
3. Select the **Issue Updated** event
4. Set the HMAC secret and use the same value for `JIRA_WEBHOOK_SECRET`

When a ticket is moved to the AI column, Blazebot picks it up automatically.

## How It Works

1. A ticket is moved to the **AI** column in Jira
2. Blazebot receives the webhook, creates a feature branch, and enqueues a job
3. A sandbox container spins up, checks out the branch, and runs the AI coding agent
4. On success, the agent's commits are pushed and a PR is created
5. The ticket moves to **AI Review** and the user is notified (if Slack is configured)
6. If the agent needs clarification, questions are posted on the ticket and it moves to **Backlog**
7. When a human moves the ticket back to AI (after review feedback or clarification), the cycle repeats

## Developer Mode

Developer mode lets you inspect what a Claude Code agent is doing inside a sandbox container in real-time.

### Setup

1. Set `DEVELOPER_MODE=true` in your `.env`
2. Rebuild the sandbox image: `docker build -t blazebot-sandbox docker/sandbox/`
3. Start the service: `pnpm dev`

### Inspecting a container

Trigger a job, then run:

```bash
pnpm inspect
```

This lists running sandbox containers and lets you pick one to attach to. If only one is running, it attaches automatically.

You'll see live, timestamped output:

```
[12:34:05] system: initialized (model: claude-sonnet-4-20250514)
[12:34:07] assistant: Let me read the codebase first.
[12:34:07] tool_use: Read(file_path)
[12:34:08] tool_result: ok
[12:34:10] assistant: Now I'll implement the feature.
[12:34:10] tool_use: Edit(file_path, new_string, old_string)
[12:34:11] tool_result: ok
[12:34:15] result: implemented
```

You can also attach manually: `docker logs -f <container_id>`.

Use `docker ps --filter label=blazebot=true` to list containers, or filter by branch: `docker ps --filter label=blazebot.branch=blazebot/PROJ-42`.

## Testing

```bash
pnpm test
```

Runs Vitest in watch mode. Use `npx vitest run` for a single pass.

## Project Structure

```
src/
  adapters/          # External service adapters (Jira, GitHub, Slack)
  sandbox/           # Docker container lifecycle management
  webhooks/          # Webhook parsing, validation, and routing
  context.ts         # Assembles requirements.md for agent runs
  env.ts             # Environment variable validation
  index.ts           # Fastify server and startup
  queue.ts           # BullMQ queue configuration
  schema.ts          # Drizzle ORM database schema
  worker.ts          # Job handlers (implementation, review_fix)
  logger.ts          # Structured JSON logging
docker/
  sandbox/           # Sandbox container Dockerfile and scripts
prompts/
  implement.md       # Agent prompt for initial implementation
  review-fix.md      # Agent prompt for fixing review feedback
docs/
  BLAZEBOT_SPEC.md   # Full service specification
```

## License

See [LICENSE](LICENSE) for details.
