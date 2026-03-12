# Phase 2: Database Schema & BullMQ — Design Spec

**Goal:** Define the database tables (tickets, agent_runs) and set up BullMQ queue infrastructure with a worker skeleton. Pure infrastructure — no business logic, no adapters, no job producers.

**Builds on:** Phase 1 (Fastify health check, Drizzle config, Docker Compose with Postgres + Redis, env validation)

---

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Thin `tickets` table — no title/description/model_label | Source of truth for ticket content is Jira/Linear. Local table exists only for FK target, dedup, and workflow status tracking. Content fetched from adapter at runtime. |
| 2 | No `clarifications` table | Clarification Q&A lives as comments in the external ticket system. When a new run starts after clarification, the adapter pulls full comment history into `requirements.md`. |
| 3 | No `status_events` / history table | YAGNI. Status column on tickets and agent_runs is sufficient for Phase 2. History tracking can be added later when Slack notifications need it. |
| 4 | Single BullMQ queue with named job types | One queue named `"ticket"` with job names like `ticket.process`, `ticket.review-fix`, `ticket.clarify`. Simpler than separate queues; BullMQ handles named jobs well. |
| 5 | Single process — worker runs alongside Fastify | Worker starts on boot and shuts down gracefully with the Fastify server. Simpler than separate processes. Can split later if scaling demands it. |
| 6 | `ioredis` for Redis connection | BullMQ requires `ioredis` specifically (not the `redis` package). Queue and Worker each get their own connection via a factory function (BullMQ Worker uses blocking commands that monopolize the connection). |
| 7 | `REDIS_URL` becomes required | BullMQ needs Redis to function. No longer optional in env validation. |
| 8 | `MAX_CONCURRENT_CONTAINERS` env var | Controls max simultaneous agent sandboxes. Defined and validated now, enforced in a future phase when Docker sandbox logic is built. |

---

## Components

### 1. Database Enums

Defined via Drizzle's `pgEnum` in `src/schema.ts`:

- **`ticketSource`**: `jira`, `linear`
- **`ticketStatus`**: `queued`, `in_progress`, `clarifying`, `in_review`, `done`, `failed`
- **`agentRunStatus`**: `provisioning`, `running`, `reviewing`, `fixing`, `merging`, `completed`, `failed`, `cancelled`
- **`agentRunTrigger`**: `new`, `review_fix`, `clarification_answer`

### 2. `tickets` table

Thin table — just enough for FK, dedup, and workflow state.

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default `gen_random_uuid()` |
| external_id | text | not null |
| source | ticketSource enum | not null |
| status | ticketStatus enum | not null, default `queued` |
| created_at | timestamp with time zone | not null, default `now()` |
| updated_at | timestamp with time zone | not null, default `now()` |

**Indexes:** unique composite on `(external_id, source)` — prevents duplicate tickets from the same provider.

### 3. `agent_runs` table

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default `gen_random_uuid()` |
| ticket_id | uuid | FK → tickets(id), not null. Default NO ACTION on delete — tickets are never deleted. |
| status | agentRunStatus enum | not null, default `provisioning` |
| trigger | agentRunTrigger enum | not null |
| branch_name | text | nullable (not known at provisioning time, set when branch is created) |
| container_id | text | nullable (filled once container is up) |
| started_at | timestamp with time zone | not null, default `now()` |
| finished_at | timestamp with time zone | nullable (set on completion/failure) |

**Indexes:** index on `ticket_id` for efficient lookups of all runs for a ticket.

### 4. `src/redis.ts` — Redis connection factory

```typescript
import IORedis from "ioredis";
import { env } from "./env.js";

export function createRedisConnection(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}
```

`maxRetriesPerRequest: null` is required by BullMQ.

Exports a factory function — Queue and Worker each need their own connection because the Worker uses blocking Redis commands that monopolize the socket.

### 5. `src/queue.ts` — Queue definition

```typescript
import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.js";

export const ticketQueue = new Queue("ticket", { connection: createRedisConnection() });
```

Job names: `ticket.process`, `ticket.review-fix`, `ticket.clarify`.

Exports a type for job data:

```typescript
export type TicketJobData = {
  ticketId: string;
};
// Will evolve into a discriminated union per job type in future phases
// (e.g., review-fix may need pullRequestId, clarify may need questionIds)
```

### 6. `src/worker.ts` — Worker skeleton

```typescript
import { Worker, Job } from "bullmq";
import { createRedisConnection } from "./redis.js";
import type { TicketJobData } from "./queue.js";

export function createWorker(): Worker<TicketJobData> {
  const worker = new Worker<TicketJobData>(
    "ticket",
    async (job: Job<TicketJobData>) => {
      console.log(`Processing job ${job.name} with data:`, job.data);
    },
    { connection: createRedisConnection() }
  );

  return worker;
}
```

No real processing — just logs. Business logic added in future phases.

### 7. `src/env.ts` — Updated environment validation

Changes from Phase 1:
- `REDIS_URL`: `z.string().url()` — **required** (was optional)
- `MAX_CONCURRENT_CONTAINERS`: `z.string().default("3").transform(v => parseInt(v, 10)).pipe(z.number().int().positive())` — **new**, rejects NaN/negative/float values

### 8. `src/index.ts` — Lifecycle integration

On startup (in `main()`):
1. Start Fastify server
2. Create worker via `createWorker()`

On shutdown:
1. `await worker.close()`
2. `await app.close()`

Worker is created after the server starts listening. Shutdown closes worker first, then server. A 30-second force-exit timeout prevents long-running jobs from blocking shutdown indefinitely:

```typescript
const shutdown = async () => {
  const forceTimeout = setTimeout(() => process.exit(1), 30_000);
  await worker.close();
  clearTimeout(forceTimeout);
  await app.close();
  process.exit(0);
};
```

### 9. Dependencies

**New production deps:**
- `bullmq` (v5)
- `ioredis` (v5)

**No new dev deps.**

### 10. Drizzle migration

After schema is defined:
1. `pnpm db:generate` — generates SQL migration in `drizzle/`
2. `pnpm db:push` — applies to local DB (or `pnpm db:migrate` for migration-based flow)

Migration files are committed to the repo for reproducibility.

---

## Testing

| Test file | What it covers |
|-----------|---------------|
| `src/schema.test.ts` | Table definitions export correctly, FK relationships defined, enums have expected values |
| `src/redis.test.ts` | Factory returns an ioredis instance with correct config (mock ioredis) |
| `src/queue.test.ts` | Queue created with correct name and connection |
| `src/worker.test.ts` | Worker processes a job and logs it |
| `src/env.test.ts` (update) | `REDIS_URL` is now required, `MAX_CONCURRENT_CONTAINERS` defaults to 3 |

All tests mock Redis/BullMQ — no Docker or Redis required to run tests.

---

## Files Changed/Created

| File | Action |
|------|--------|
| `src/schema.ts` | Rewrite (currently empty barrel file) |
| `src/redis.ts` | Create |
| `src/queue.ts` | Create |
| `src/worker.ts` | Create |
| `src/env.ts` | Modify (REDIS_URL required, add MAX_CONCURRENT_CONTAINERS) |
| `src/index.ts` | Modify (start worker, graceful shutdown) |
| `src/schema.test.ts` | Create |
| `src/redis.test.ts` | Create |
| `src/queue.test.ts` | Create |
| `src/worker.test.ts` | Create |
| `src/env.test.ts` | Modify (new test cases) |
| `src/index.test.ts` | Modify (account for worker in startup) |
| `drizzle/*.sql` | Generated migration files |
| `.env.example` | Modify (REDIS_URL required, add MAX_CONCURRENT_CONTAINERS) |
| `package.json` | Modify (add bullmq, ioredis) |
