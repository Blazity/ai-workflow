# Phase 2: Database Schema & BullMQ — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the database tables (tickets, agent_runs) and set up BullMQ queue infrastructure with a worker skeleton. Pure infrastructure — no business logic, no adapters, no job producers.

**Architecture:** Two Drizzle tables (tickets, agent_runs) with pgEnums for statuses. BullMQ queue and worker skeleton using ioredis, running in the same process as Fastify. Redis connection uses a factory function (Queue and Worker need separate connections). Environment validation updated to require REDIS_URL and add MAX_CONCURRENT_CONTAINERS.

**Tech Stack:** Node.js 20+, TypeScript 5.9 (strict ESM), Drizzle ORM 0.45, BullMQ 5, ioredis 5, Zod 3, Vitest 4, pnpm

**Spec:** `docs/superpowers/specs/2026-03-12-phase2-schema-bullmq-design.md`

---

## Chunk 1: Dependencies & Environment

### Task 1: Install BullMQ and ioredis

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install production dependencies**

Run: `pnpm add bullmq@5 ioredis@5`

- [ ] **Step 2: Verify installation**

Run: `pnpm ls bullmq ioredis`
Expected: Both packages listed with v5.x versions.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add bullmq and ioredis dependencies"
```

---

### Task 2: Update environment validation

**Files:**
- Create: `src/env.test.ts`
- Modify: `src/env.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/env.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("env", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("validates when all required env vars are set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/db");
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
  });

  it("throws when REDIS_URL is missing", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    await expect(import("./env.js")).rejects.toThrow();
  });

  it("throws when MAX_CONCURRENT_CONTAINERS is not a positive integer", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("MAX_CONCURRENT_CONTAINERS", "0");

    await expect(import("./env.js")).rejects.toThrow();
  });

  it("uses default PORT of 3000", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.PORT).toBe(3000);
  });

  it("uses default MAX_CONCURRENT_CONTAINERS of 3", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.MAX_CONCURRENT_CONTAINERS).toBe(3);
  });

  it("parses MAX_CONCURRENT_CONTAINERS as integer", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("MAX_CONCURRENT_CONTAINERS", "5");

    const { env } = await import("./env.js");
    expect(env.MAX_CONCURRENT_CONTAINERS).toBe(5);
  });

  it("uses default NODE_ENV of development", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.NODE_ENV).toBe("development");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run`
Expected: FAIL — `REDIS_URL` is currently optional so the "validates when all required" test may pass, but `MAX_CONCURRENT_CONTAINERS` tests will fail because it doesn't exist in `env.ts` yet.

- [ ] **Step 3: Update `src/env.ts`**

Replace the full contents of `src/env.ts`:

```typescript
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    PORT: z
      .string()
      .default("3000")
      .transform((v) => parseInt(v, 10)),
    MAX_CONCURRENT_CONTAINERS: z
      .string()
      .default("3")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
  },
  runtimeEnv: process.env,
});
```

Changes from Phase 1:
- `REDIS_URL`: removed `.optional()` — now required
- `MAX_CONCURRENT_CONTAINERS`: new field with `.pipe(z.number().int().positive())` to reject NaN/negative

- [ ] **Step 4: Update `src/index.test.ts` to stub REDIS_URL**

The existing health check test needs `REDIS_URL` stubbed since it's now required. Update the `beforeEach` in `src/index.test.ts`:

```typescript
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("PORT", "0");
  });
```

The only change is adding the `vi.stubEnv("REDIS_URL", ...)` line.

- [ ] **Step 5: Update `.env.example`**

```
DATABASE_URL=postgresql://blazebot:blazebot@localhost:5432/blazebot
REDIS_URL=redis://localhost:6379
PORT=3000
NODE_ENV=development
MAX_CONCURRENT_CONTAINERS=3

# Docker Compose Postgres config
POSTGRES_USER=blazebot
POSTGRES_PASSWORD=blazebot
POSTGRES_DB=blazebot
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- --run`
Expected: All tests PASS (env tests + health check test).

- [ ] **Step 7: Commit**

```bash
git add src/env.ts src/env.test.ts src/index.test.ts .env.example
git commit -m "feat: require REDIS_URL and add MAX_CONCURRENT_CONTAINERS env var"
```

---

## Chunk 2: Database Schema & Migration

### Task 3: Define database schema

**Files:**
- Create: `src/schema.test.ts`
- Modify: `src/schema.ts`

- [ ] **Step 1: Write the failing test**

Create `src/schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("schema", () => {
  describe("enums", () => {
    it("exports ticket source enum with expected values", async () => {
      const { ticketSourceEnum } = await import("./schema.js");
      expect(ticketSourceEnum.enumValues).toEqual(["jira", "linear"]);
    });

    it("exports ticket status enum with expected values", async () => {
      const { ticketStatusEnum } = await import("./schema.js");
      expect(ticketStatusEnum.enumValues).toEqual([
        "queued",
        "in_progress",
        "clarifying",
        "in_review",
        "done",
        "failed",
      ]);
    });

    it("exports agent run status enum with expected values", async () => {
      const { agentRunStatusEnum } = await import("./schema.js");
      expect(agentRunStatusEnum.enumValues).toEqual([
        "provisioning",
        "running",
        "reviewing",
        "fixing",
        "merging",
        "completed",
        "failed",
        "cancelled",
      ]);
    });

    it("exports agent run trigger enum with expected values", async () => {
      const { agentRunTriggerEnum } = await import("./schema.js");
      expect(agentRunTriggerEnum.enumValues).toEqual([
        "new",
        "review_fix",
        "clarification_answer",
      ]);
    });
  });

  describe("tables", () => {
    it("exports tickets table", async () => {
      const { tickets } = await import("./schema.js");
      expect(tickets).toBeDefined();
    });

    it("exports agentRuns table", async () => {
      const { agentRuns } = await import("./schema.js");
      expect(agentRuns).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run`
Expected: FAIL — `schema.ts` exports nothing (empty barrel file).

- [ ] **Step 3: Write `src/schema.ts`**

Replace the full contents of `src/schema.ts`:

```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

// Enums

export const ticketSourceEnum = pgEnum("ticket_source", ["jira", "linear"]);

export const ticketStatusEnum = pgEnum("ticket_status", [
  "queued",
  "in_progress",
  "clarifying",
  "in_review",
  "done",
  "failed",
]);

export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "provisioning",
  "running",
  "reviewing",
  "fixing",
  "merging",
  "completed",
  "failed",
  "cancelled",
]);

export const agentRunTriggerEnum = pgEnum("agent_run_trigger", [
  "new",
  "review_fix",
  "clarification_answer",
]);

// Tables

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    externalId: text("external_id").notNull(),
    source: ticketSourceEnum("source").notNull(),
    status: ticketStatusEnum("status").notNull().default("queued"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("tickets_external_id_source_unique").on(t.externalId, t.source)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id),
    status: agentRunStatusEnum("status").notNull().default("provisioning"),
    trigger: agentRunTriggerEnum("trigger").notNull(),
    branchName: text("branch_name"),
    containerId: text("container_id"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("agent_runs_ticket_id_idx").on(t.ticketId)],
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run`
Expected: All tests PASS.

- [ ] **Step 5: Verify TypeScript compilation**

Run: `pnpm build`
Expected: Compiles with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/schema.ts src/schema.test.ts
git commit -m "feat: add tickets and agent_runs tables with Drizzle schema"
```

---

### Task 4: Generate and apply Drizzle migration

**Files:**
- Create: `drizzle/*.sql` (generated)

**Prerequisite:** Docker Compose must be running for database access.

- [ ] **Step 1: Start Postgres**

Run: `docker compose up -d postgres`
Run: `docker compose ps`
Expected: `postgres` service is "Up" and healthy.

- [ ] **Step 2: Ensure `.env` has correct DATABASE_URL**

The `.env` file should already exist from Phase 1 with `DATABASE_URL=postgresql://blazebot:blazebot@localhost:5432/blazebot`. Verify it exists:

Run: `test -f .env && echo "exists" || echo "missing"`
Expected: `exists`

If missing, run: `cp .env.example .env`

- [ ] **Step 3: Generate migration**

Run: `pnpm db:generate`
Expected: Migration SQL file(s) created in `drizzle/` directory. Output shows tables and enums being created.

- [ ] **Step 4: Apply migration**

Run: `pnpm db:migrate`
Expected: Migration applied successfully. Tables `tickets` and `agent_runs` created with their enums.

- [ ] **Step 5: Verify tables exist**

Run: `docker compose exec postgres psql -U blazebot -d blazebot -c "\dt"`
Expected: `tickets` and `agent_runs` tables listed.

Run: `docker compose exec postgres psql -U blazebot -d blazebot -c "\dT+"`
Expected: `ticket_source`, `ticket_status`, `agent_run_status`, `agent_run_trigger` types listed.

- [ ] **Step 6: Commit migration files**

```bash
git add drizzle/
git commit -m "chore: add initial database migration for tickets and agent_runs"
```

---

## Chunk 3: Redis, Queue & Worker

### Task 5: Redis connection factory

**Files:**
- Create: `src/redis.ts`
- Create: `src/redis.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/redis.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => {
  return { default: vi.fn() };
});

describe("createRedisConnection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  });

  it("creates an IORedis instance with the correct URL and config", async () => {
    const ioredis = await import("ioredis");
    const { createRedisConnection } = await import("./redis.js");

    createRedisConnection();

    expect(ioredis.default).toHaveBeenCalledWith("redis://localhost:6379", {
      maxRetriesPerRequest: null,
    });
  });

  it("returns a new instance on each call", async () => {
    const { createRedisConnection } = await import("./redis.js");

    const conn1 = createRedisConnection();
    const conn2 = createRedisConnection();

    expect(conn1).not.toBe(conn2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run`
Expected: FAIL — `./redis.js` module not found.

- [ ] **Step 3: Write `src/redis.ts`**

```typescript
import IORedis from "ioredis";
import { env } from "./env.js";

export function createRedisConnection(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/redis.ts src/redis.test.ts
git commit -m "feat: add Redis connection factory for BullMQ"
```

---

### Task 6: Queue definition

**Files:**
- Create: `src/queue.ts`
- Create: `src/queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/queue.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => ({ default: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: vi.fn() }));

describe("ticketQueue", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  });

  it("creates a queue named 'ticket'", async () => {
    const bullmq = await import("bullmq");
    await import("./queue.js");

    expect(bullmq.Queue).toHaveBeenCalledWith(
      "ticket",
      expect.objectContaining({ connection: expect.anything() }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run`
Expected: FAIL — `./queue.js` module not found.

- [ ] **Step 3: Write `src/queue.ts`**

```typescript
import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.js";

export type TicketJobData = {
  ticketId: string;
};
// Will evolve into a discriminated union per job type in future phases
// (e.g., review-fix may need pullRequestId, clarify may need questionIds)

export const ticketQueue = new Queue<TicketJobData>("ticket", {
  connection: createRedisConnection(),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/queue.ts src/queue.test.ts
git commit -m "feat: add BullMQ ticket queue definition"
```

---

### Task 7: Worker skeleton

**Files:**
- Create: `src/worker.ts`
- Create: `src/worker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/worker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => ({ default: vi.fn() }));
vi.mock("bullmq", () => ({ Worker: vi.fn() }));

describe("createWorker", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  });

  it("creates a worker on the 'ticket' queue", async () => {
    const bullmq = await import("bullmq");
    const { createWorker } = await import("./worker.js");

    createWorker();

    expect(bullmq.Worker).toHaveBeenCalledWith(
      "ticket",
      expect.any(Function),
      expect.objectContaining({ connection: expect.anything() }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run`
Expected: FAIL — `./worker.js` module not found.

- [ ] **Step 3: Write `src/worker.ts`**

```typescript
import { Worker, Job } from "bullmq";
import { createRedisConnection } from "./redis.js";
import type { TicketJobData } from "./queue.js";

export function createWorker(): Worker<TicketJobData> {
  return new Worker<TicketJobData>(
    "ticket",
    async (job: Job<TicketJobData>) => {
      console.log(`Processing job ${job.name} with data:`, job.data);
    },
    { connection: createRedisConnection() },
  );
}
```

Note: `import type { TicketJobData }` is erased at runtime, so this does NOT cause `queue.ts` to be evaluated (no eager Redis connection from queue module).

Note: `MAX_CONCURRENT_CONTAINERS` is deliberately not wired into the worker's `concurrency` option yet. It will be used in a future phase when Docker sandbox logic enforces the container limit.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: add BullMQ worker skeleton for ticket queue"
```

---

## Chunk 4: Lifecycle Integration & Verification

### Task 8: Wire worker into Fastify lifecycle

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Update `src/index.test.ts` to mock transitive dependencies**

The updated `index.ts` will import `./worker.js` which transitively imports `ioredis` and `bullmq`. Even though `buildApp()` doesn't use the worker, the module-level import triggers the transitive dependency chain. Add mocks at the top of `src/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => ({ default: vi.fn() }));
vi.mock("bullmq", () => ({ Worker: vi.fn() }));

describe("GET /health", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("PORT", "0");
  });

  it("returns status ok", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });
});
```

- [ ] **Step 2: Update `src/index.ts`**

Replace the full contents of `src/index.ts`:

```typescript
import Fastify from "fastify";
import { env } from "./env.js";
import { createWorker } from "./worker.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
}

async function main() {
  const app = buildApp();
  const worker = createWorker();

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async () => {
    const forceTimeout = setTimeout(() => process.exit(1), 30_000);
    await worker.close();
    clearTimeout(forceTimeout);
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

Changes from Phase 1:
- Import `createWorker` from `./worker.js`
- Create worker in `main()` after building the app
- Shutdown: close worker first (with 30s force timeout), then close Fastify

Note: `buildApp()` is unchanged — it does NOT start the worker. Tests use `buildApp()` directly, so they are unaffected by the worker lifecycle.

- [ ] **Step 2: Run all tests**

Run: `pnpm test -- --run`
Expected: All tests PASS. The health check test still works because it only calls `buildApp()`, not `main()`.

- [ ] **Step 3: Verify TypeScript compilation**

Run: `rm -rf dist && pnpm build`
Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: wire BullMQ worker into Fastify server lifecycle"
```

---

### Task 9: End-to-end verification

**Files:**
- None — verification only

- [ ] **Step 1: Start infrastructure**

Run: `docker compose up -d`
Run: `docker compose ps`
Expected: Both `postgres` and `redis` services are "Up" and healthy.

- [ ] **Step 2: Ensure `.env` has REDIS_URL**

Check `.env` has `REDIS_URL=redis://localhost:6379`. If not, copy from `.env.example`:

Run: `grep REDIS_URL .env || echo "missing"`

- [ ] **Step 3: Start dev server**

Run: `pnpm dev` (in foreground or background)
Expected: Server starts, logs show Fastify listening on port 3000 and no Redis connection errors.

- [ ] **Step 4: Test health endpoint**

Run (in another terminal): `curl http://localhost:3000/health`
Expected: `{"status":"ok"}`

- [ ] **Step 5: Stop dev server and tear down**

Stop the dev server (Ctrl+C).
Run: `docker compose down`

- [ ] **Step 6: Clean build verification**

Run: `rm -rf dist && pnpm build`
Expected: Compiles with no errors.

- [ ] **Step 7: Run full test suite**

Run: `pnpm test -- --run`
Expected: All tests pass.

- [ ] **Step 8: Verify `.env` is gitignored**

Run: `git status`
Expected: `.env` does NOT appear in untracked files.

- [ ] **Step 9: Final commit (if any unstaged changes)**

```bash
git status
# Only commit if there are meaningful changes
```
