# Phase 1: Infrastructure Boilerplate — Design Spec

## Overview

First phase of Blazebot implementation. Sets up the foundational infrastructure with no business logic: Docker Compose for Postgres and Redis, a minimal Fastify server, Drizzle ORM configuration, and type-safe environment variables.

## Decisions

- **Package manager**: pnpm
- **Docker strategy**: Postgres + Redis in Docker Compose; Fastify app runs on host via `pnpm dev`
- **Project structure**: Minimal flat `src/` — restructure when adding logic
- **Database schema**: Drizzle config only, no tables yet
- **BullMQ**: Deferred to a later phase — Redis is provisioned now so BullMQ can be added without infra changes
- **Health check**: Shallow (static response, no DB/Redis ping) — will deepen when services are wired up
- **Zod version**: Use Zod v3 initially since `@t3-oss/env-core` requires it; migrate to Zod v4 when `@t3-oss/env-core` adds support
- **TypeScript**: Pin to v5.9 per tech stack

## Project Structure

```
ai-workflow/
├── src/
│   ├── index.ts          # Fastify app entry point
│   ├── db.ts             # Drizzle client + connection
│   ├── schema.ts         # Empty barrel file for Drizzle schema
│   └── env.ts            # Type-safe env vars (Zod + @t3-oss/env-core)
├── drizzle.config.ts     # Drizzle Kit config
├── vitest.config.ts      # Vitest config
├── docker-compose.yml    # Postgres + Redis
├── package.json
├── tsconfig.json
├── .nvmrc                # Node.js version (20)
├── .env.example          # Template for required env vars
├── .gitignore
└── docs/
```

## Components

### 1. Docker Compose (`docker-compose.yml`)

Two services:

- **postgres**: PostgreSQL 16 image, port 5432, named volume for data persistence, health check via `pg_isready`
- **redis**: Redis 7 image, port 6379, named volume for data persistence, health check via `redis-cli ping`

Environment variables for Postgres (user, password, db name) read from `.env` file automatically by Docker Compose.

### 2. Environment Variables (`src/env.ts`)

Uses `@t3-oss/env-core` + Zod. Validates at startup, crashes early with clear errors if anything is missing.

Variables:

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | _(required)_ |
| `REDIS_URL` | Redis connection string | _(optional — validated but no connection established until BullMQ phase)_ |
| `PORT` | Fastify listen port | `3000` |
| `NODE_ENV` | `development` or `production` | `development` |

### 3. Fastify App (`src/index.ts`)

Minimal Fastify v5 server:

- `GET /health` route returning `{ status: "ok" }`
- Reads `PORT` from `env.ts`
- Graceful shutdown on `SIGTERM`/`SIGINT`
- No plugins, no other routes
- Does **not** import `db.ts` — no eager DB connection at startup in this phase

### 4. Database Connection (`src/db.ts`)

- Creates a `postgres` driver instance using `DATABASE_URL` from `env.ts`
- Exports a Drizzle ORM client wrapping the connection
- No schema, no tables — connection only

### 5. Drizzle Config (`drizzle.config.ts`)

- `dialect: "postgresql"`
- Connection via `DATABASE_URL` env var
- Schema path: `src/schema.ts` (empty barrel file — no tables yet, but file exists so `drizzle-kit` commands don't error)
- Migrations output: `drizzle/` directory

### 6. TypeScript Config (`tsconfig.json`)

- Strict mode enabled
- ESM: `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`
- Target: ES2022

### 7. Package.json

- `"type": "module"` for ESM
- `engines`: `{ "node": ">=20" }`
- Scripts: `dev` (`tsx watch src/index.ts`), `build` (`tsc`), `start` (`node dist/index.js`), `test` (`vitest`), `db:generate` (`drizzle-kit generate`), `db:migrate` (`drizzle-kit migrate`), `db:push` (`drizzle-kit push`)
- Dependencies: fastify v5, drizzle-orm v0.45, postgres v3.4, zod v3, @t3-oss/env-core
- Dev dependencies: typescript v5.9, tsx, @types/node, drizzle-kit, vitest v4

### 8. `.env.example`

```
DATABASE_URL=postgresql://blazebot:blazebot@localhost:5432/blazebot
REDIS_URL=redis://localhost:6379
PORT=3000
NODE_ENV=development
```

### 9. `.gitignore`

Standard Node.js gitignore + `.env`, `node_modules/`, `dist/`. Note: `drizzle/` migrations directory is **committed** to the repo for reproducibility across environments.
