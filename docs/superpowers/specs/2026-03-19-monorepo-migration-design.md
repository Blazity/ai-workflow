# Monorepo Migration Design

**Date:** 2026-03-19
**Goal:** Restructure Blazebot from a single-package app into a pnpm workspaces monorepo, separating the API server and worker into independently deployable units for AWS deployment.

## Package Structure

```
blazebot/
├── packages/
│   ├── api/                        # @blazebot/api — deployable
│   │   ├── src/
│   │   │   ├── index.ts            # Fastify server, health check, graceful shutdown
│   │   │   └── webhooks/
│   │   │       ├── jira.ts         # Jira webhook handler + HMAC validation
│   │   │       ├── router.ts       # Event routing, ticket upsert, job enqueue
│   │   │       └── types.ts        # Webhook event types
│   │   ├── Dockerfile
│   │   ├── package.json            # depends on @blazebot/shared
│   │   └── tsconfig.json
│   │
│   ├── worker/                     # @blazebot/worker — deployable
│   │   ├── src/
│   │   │   ├── index.ts            # Worker startup, container cleanup, shutdown
│   │   │   ├── worker.ts           # BullMQ job handlers (implement, review-fix)
│   │   │   ├── poller.ts           # Maintenance polling (missed webhooks, stuck jobs)
│   │   │   ├── context.ts          # requirements.md assembly
│   │   │   └── sandbox/
│   │   │       └── manager.ts      # Docker container lifecycle
│   │   ├── Dockerfile
│   │   ├── package.json            # depends on @blazebot/shared
│   │   └── tsconfig.json
│   │
│   └── shared/                     # @blazebot/shared — library
│       ├── src/
│       │   ├── index.ts            # barrel export
│       │   ├── env.ts              # zod env validation
│       │   ├── db.ts               # Postgres connection
│       │   ├── redis.ts            # ioredis connection
│       │   ├── schema.ts           # Drizzle table definitions
│       │   ├── queue.ts            # BullMQ queue + job types
│       │   ├── logger.ts           # Pino logger
│       │   └── adapters/
│       │       ├── github-client.ts
│       │       ├── jira-client.ts
│       │       ├── messaging.ts        # MessagingAdapter interface
│       │       ├── slack-messaging.ts
│       │       ├── noop-messaging.ts
│       │       ├── console-messaging.ts
│       │       ├── messaging-factory.ts
│       │       ├── source-control.ts
│       │       └── ticket.ts
│       ├── package.json
│       └── tsconfig.json
│
├── docker/
│   └── sandbox/                    # unchanged
│
├── drizzle/                        # migrations stay at root
├── prompts/                        # agent prompts stay at root
├── docs/
├── scripts/
├── docker-compose.yml
├── pnpm-workspace.yaml
├── package.json                    # root scripts
├── tsconfig.base.json
├── drizzle.config.ts
└── vitest.config.ts
```

## Package Dependencies & Boundaries

### Dependency graph

```
@blazebot/api  ──→  @blazebot/shared  ←──  @blazebot/worker
```

No direct dependency between API and Worker. They communicate only through the Redis-backed BullMQ queue.

### Package ownership

| Package | Owns | Key external deps |
|---------|------|-------------------|
| `@blazebot/shared` | db, redis, schema, queue, env, logger, adapters | `drizzle-orm`, `postgres`, `ioredis`, `bullmq`, `zod`, `pino`, `@octokit/rest`, `@slack/web-api` |
| `@blazebot/api` | HTTP server, webhook parsing, routing | `fastify` |
| `@blazebot/worker` | Job handlers, poller, sandbox manager, context builder | `dockerode` |

### Import rule

API and Worker import from `@blazebot/shared`. Never from each other.

### Cross-boundary container teardown

The current `router.ts` imports `teardownContainer` from `sandbox/manager.ts`. Since the sandbox manager lives in the worker package, this creates a cross-package dependency that violates the import rule.

**Solution:** The API enqueues a cancellation job via BullMQ instead of directly calling `teardownContainer`. The worker package handles the actual container teardown when it picks up the cancellation job. This keeps the boundary clean — API only writes to the queue, worker only manages containers.

Changes required:
- Add a `cancellation` job type to the shared queue definition
- Remove the `teardownContainer` import from `router.ts` — replace with `queue.add("cancellation", { ticketId })`
- Add a cancellation job handler in the worker

### Environment variables

The current `env.ts` uses `@t3-oss/env-core` which eagerly validates all declared vars on import. A single unified schema would crash the API at startup because worker-only required vars (e.g., `CLAUDE_CODE_OAUTH_TOKEN`) wouldn't be set.

**Solution:** Split into per-package env schemas:
- **`@blazebot/shared` `env.ts`** — validates only vars needed by shared code: `DATABASE_URL`, `REDIS_URL`, `LOG_LEVEL`, `COLUMN_AI`, `COLUMN_AI_REVIEW`, `COLUMN_BACKLOG`, `JOB_MAX_RETRIES`, `JOB_BACKOFF_MS`
- **`@blazebot/api` `env.ts`** — extends shared env, adds: `PORT`, `JIRA_WEBHOOK_SECRET`
- **`@blazebot/worker` `env.ts`** — extends shared env, adds: `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_MODEL`, `DOCKER_IMAGE`, `SANDBOX_MEMORY_MB`, `MAX_CONCURRENT_AGENTS`, `JOB_TIMEOUT_MS`, `POLL_INTERVAL_MS`, `STUCK_JOB_THRESHOLD_MS`, `DEVELOPER_MODE`, `SLACK_BOT_TOKEN`, `SLACK_DEFAULT_CHANNEL`

Each package validates only what it needs at startup. No runtime crashes from missing irrelevant vars.

## Build, Dev & Test Setup

### Root scripts

```json
{
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "db:push": "drizzle-kit push",
    "db:generate": "drizzle-kit generate"
  }
}
```

### Per-package build

- Each package has its own `tsconfig.json` extending a root `tsconfig.base.json`
- `shared` builds first (dependency order respected automatically via workspace protocol)
- Each package compiles with `tsc` to its own `dist/`

### Dev mode

- `pnpm dev` runs all packages' `dev` scripts in parallel (`tsx watch`)
- Logs from API and Worker interleave in the same terminal
- `docker compose up` needed separately for Postgres + Redis

### Testing

- Per-package vitest configs so each package runs its own tests
- `pnpm test` at root runs all, `pnpm --filter @blazebot/api test` runs one
- Tests move with their source files into the respective packages

### TypeScript project references

- Root `tsconfig.base.json` with shared compiler options
- Each package's `tsconfig.json` extends base and uses `references` to point at `shared`
- Enables incremental builds and cross-package IDE navigation

## Docker & Deployment

### Dockerfiles

**`packages/api/Dockerfile`** — multi-stage build:
1. Install deps (pnpm workspace, only api + shared)
2. Build TypeScript
3. Slim runtime image, runs `node packages/api/dist/index.js`
4. Lightweight — no Docker socket, no heavy deps

**`packages/worker/Dockerfile`** — same multi-stage pattern:
1. Install deps (pnpm workspace, only worker + shared)
2. Build TypeScript
3. Runtime image, runs `node packages/worker/dist/index.js`
4. Needs Docker socket mount for spawning sandbox containers

### docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-blazebot}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-blazebot}
      POSTGRES_DB: ${POSTGRES_DB:-blazebot}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-blazebot}"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
    ports:
      - "3000:3000"
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }

  worker:
    build:
      context: .
      dockerfile: packages/worker/Dockerfile
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }

volumes:
  postgres_data:
  redis_data:
```

### AWS deployment mapping

| Package | AWS Service | Notes |
|---------|-------------|-------|
| `@blazebot/api` | EC2 / ECS Fargate | Stateless, scales horizontally |
| `@blazebot/worker` | EC2 (not Fargate) | Needs Docker socket for sandbox containers |
| Postgres | RDS | Managed |
| Redis | ElastiCache | Managed |
| Sandbox image | ECR | Pre-built, pulled by worker |

**Note:** Worker cannot run on Fargate because it needs the Docker socket to spawn sandbox containers. EC2-backed ECS or plain EC2 is required.

## Migration Strategy

The migration is a restructuring of existing code, not a rewrite:

1. Set up pnpm workspaces config and root `tsconfig.base.json`
2. Create the three package directories with their `package.json` and `tsconfig.json`
3. Move source files from `src/` into the appropriate packages
4. Update all import paths
5. Create barrel export in `@blazebot/shared`
6. Split dependencies from root `package.json` into per-package `package.json`
7. Move and update tests to their new locations
8. Write Dockerfiles for api and worker
9. Update `docker-compose.yml`
10. Update root scripts
11. Verify: `pnpm build`, `pnpm test`, `pnpm dev`, `docker compose up` all work
