# Tech Stack

## Runtime & Language

- **Node.js** (v20+) — JavaScript runtime
- **TypeScript** (v5.9) — Type-safe language, strict mode, ES modules

## Web Framework

- **Fastify** (v5) — HTTP server for webhooks and health checks

## Database

- **PostgreSQL** (v16) — Primary relational database
- **Drizzle ORM** (v0.45) — ORM and query builder
- **Drizzle Kit** — Schema migrations and studio GUI
- **postgres** (v3.4) — PostgreSQL driver

## Queue & Workers

- **BullMQ** (v5) — Redis-backed job queue with retries and backoff
- **Redis** (v7) — In-memory store for BullMQ queues

## Containerization

- **Docker** — Sandbox containers for Claude Code agents
- **Docker Compose** — Multi-service orchestration (dev & prod)
- **Dockerode** (v4) — Node.js Docker API client

## External Services (Adapter Pattern)

All external integrations are behind isolated adapter interfaces so that swapping a provider is a single-module replacement with no changes to core logic (PRD requirement #5).

- **Ticket Tracking**: Jira via REST API v3 (current) — Linear, Asana (future adapters)
- **Messaging**: Slack via `@slack/web-api` (v7) (current) — Teams (future adapter)
- **Source Control**: GitHub via `@octokit/rest` (v22) (current) — PR creation, reviews, status checks

## AI / Coding Agents

- **Claude Code CLI** (current) — AI coding agent running inside sandbox containers
- **Codex** (planned) — future adapter for OpenAI Codex agent

## Validation & Configuration

- **Zod** (v4) — Schema validation
- **@t3-oss/env-core** — Type-safe environment variables
## Testing

- **Vitest** (v4) — Unit test runner

