# Durable Workflow Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the BullMQ worker + Fastify API two-package architecture with a single Nitro app using durable workflows for fault-tolerant, long-running ticket processing.

**Architecture:** The monorepo's `@blazebot/api` and `@blazebot/worker` packages are consolidated into a single `packages/app` powered by Nitro (server framework) with a `workflow` module for durable execution. Webhook routes, workflow orchestrators, and maintenance polling all run inside one process. Each workflow uses `"use workflow"` / `"use step"` directives — the framework persists state to PostgreSQL, enabling automatic retries and crash recovery without BullMQ or Redis.

**Tech Stack:** Nitro, `workflow` (durable execution framework with Postgres backend), Drizzle ORM, Dockerode, Zod, pino

**Supersedes:** `2026-03-19-monorepo-migration.md` (which described the API+Worker split that this branch replaces)

---

### Task 1: Scaffold the app package with Nitro

**Files:**
- Create: `packages/app/package.json`
- Create: `packages/app/tsconfig.json`
- Create: `packages/app/vitest.config.ts`
- Create: `packages/app/nitro.config.ts`

**Step 1: Create packages/app/package.json**

```json
{
  "name": "@blazebot/app",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "nitro build",
    "dev": "nitro dev",
    "start": "node .output/server/index.mjs",
    "test": "vitest"
  },
  "dependencies": {
    "@blazebot/shared": "workspace:*",
    "@t3-oss/env-core": "^0.13.10",
    "dockerode": "^4.0.9",
    "drizzle-orm": "~0.45.1",
    "nitro": "^2.11.12",
    "postgres": "~3.4.8",
    "workflow": "latest",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/dockerode": "^3.3.26",
    "@types/node": "^25.4.0",
    "typescript": "~5.9.3",
    "vitest": "^4.0.18"
  }
}
```

**Step 2: Create packages/app/nitro.config.ts**

Nitro loads the `workflow` module and targets PostgreSQL as the durable execution backend:

```ts
import nitro from "nitro";
import workflow from "workflow/nitro";

export default nitro({
  modules: [workflow],
  workflow: {
    world: "postgres",
  },
  srcDir: "src",
  scanDirs: ["src/routes", "src/plugins", "src/middleware"],
});
```

**Step 3: Create packages/app/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", ".output"]
}
```

**Step 4: Create packages/app/vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

**Step 5: Commit**

```
feat: scaffold packages/app with Nitro and workflow module
```

---

### Task 2: Create app-specific environment validation

**Files:**
- Create: `packages/app/src/env.ts`

**Step 1: Create appEnv with all app-specific vars**

The app package owns ALL runtime vars that were previously split between API and Worker packages. Shared vars (DATABASE_URL, column names, etc.) remain in `@blazebot/shared`.

```ts
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const appEnv = createEnv({
  server: {
    // API
    JIRA_WEBHOOK_SECRET: z.string().min(1),
    PORT: z.string().default("3000")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),

    // Worker / Sandbox
    MAX_CONCURRENT_AGENTS: z.string().default("3")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    JIRA_BASE_URL: z.string().url().optional(),
    JIRA_USER_EMAIL: z.string().email().optional(),
    JIRA_API_TOKEN: z.string().min(1).optional(),
    JIRA_PROJECT_KEY: z.string().min(1),
    GITHUB_TOKEN: z.string().min(1).optional(),
    GITHUB_REPO_OWNER: z.string().min(1).optional(),
    GITHUB_REPO_NAME: z.string().min(1).optional(),
    GITHUB_BASE_BRANCH: z.string().default("main"),
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
    CLAUDE_MODEL: z.string().default("claude-opus-4-6"),
    DOCKER_IMAGE: z.string().default("blazebot-sandbox"),
    SANDBOX_MEMORY_MB: z.string().default("4096")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    DEVELOPER_MODE: z.enum(["true", "false"]).default("false")
      .transform((v) => v === "true"),
    JOB_TIMEOUT_MS: z.string().default("600000")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    POLL_INTERVAL_MS: z.string().default("300000")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    STUCK_JOB_THRESHOLD_MS: z.string().optional()
      .transform((v) => (v ? parseInt(v, 10) : undefined))
      .pipe(z.number().int().positive().optional()),
  },
  runtimeEnv: process.env,
});
```

**Step 2: Commit**

```
feat: add app-specific environment validation
```

---

### Task 3: Create Nitro routes and shared libraries

**Files:**
- Create: `packages/app/src/routes/health.get.ts`
- Create: `packages/app/src/routes/webhooks/jira.post.ts`
- Create: `packages/app/src/lib/jira-signature.ts`
- Create: `packages/app/src/lib/adapters.ts`
- Move: `packages/worker/src/context.ts` → `packages/app/src/context.ts`
- Move: `packages/worker/src/sandbox/manager.ts` → `packages/app/src/sandbox/manager.ts`
- Move: `packages/worker/prompts/` → `packages/app/prompts/`

**Step 1: Create health route**

Nitro auto-discovers file-based routes. `health.get.ts` maps to `GET /health`:

```ts
export default defineEventHandler(() => ({ status: "ok" }));
```

**Step 2: Create Jira webhook route**

`webhooks/jira.post.ts` maps to `POST /webhooks/jira`:

```ts
import { verifyJiraWebhookSignature } from "../../lib/jira-signature.js";
import { routeTicketTransition } from "../../lib/webhook-router.js";
import { parseJiraWebhook, createLogger } from "@blazebot/shared";
import { appEnv } from "../../env.js";

const logger = createLogger();

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event, false);
  if (!rawBody) {
    setResponseStatus(event, 401);
    return { error: "invalid signature" };
  }

  const signature = getHeader(event, "x-hub-signature");
  const valid = verifyJiraWebhookSignature(
    Buffer.from(rawBody),
    signature ?? undefined,
    appEnv.JIRA_WEBHOOK_SECRET,
  );
  if (!valid) {
    setResponseStatus(event, 401);
    return { error: "invalid signature" };
  }

  const body = await readBody(event);
  const normalized = parseJiraWebhook(body);
  if (normalized) {
    await routeTicketTransition(normalized);
  }
  return { ok: true };
});
```

**Step 3: Create jira-signature.ts**

Extracted from the old API package — same HMAC-SHA256 verification:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyJiraWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

**Step 4: Create adapters.ts**

Factory for creating external service adapters and reading prompt files:

```ts
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JiraClient,
  GitHubClient,
  createMessagingAdapter,
  env,
} from "@blazebot/shared";
import { appEnv } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

export function createAdapters() {
  const jira = new JiraClient(
    appEnv.JIRA_BASE_URL!,
    appEnv.JIRA_USER_EMAIL!,
    appEnv.JIRA_API_TOKEN!,
  );
  const github = new GitHubClient(appEnv.GITHUB_TOKEN!);
  const messaging = createMessagingAdapter(
    env.MESSAGING_KIND,
    env.SLACK_BOT_TOKEN,
    env.SLACK_DEFAULT_CHANNEL,
  );
  return { jira, github, messaging };
}

export async function readPromptFile(filename: string): Promise<string> {
  const filePath = resolve(PROMPTS_DIR, filename);
  return readFile(filePath, "utf-8");
}
```

**Step 5: Move context.ts and sandbox/manager.ts from old worker**

Move files, updating imports from `@blazebot/shared` and `../env.js` → `../env.js`. Remove BullMQ/ioredis dependencies since sandbox manager no longer needs queue access.

**Step 6: Move prompts/ directory**

```bash
mv packages/worker/prompts packages/app/prompts
```

**Step 7: Commit**

```
feat: add Nitro routes and shared libraries for app package
```

---

### Task 4: Create webhook router with workflow integration

**Files:**
- Create: `packages/app/src/lib/webhook-router.ts`
- Create: `packages/app/src/lib/workflow-helpers.ts`

**Step 1: Create workflow-helpers.ts**

This replaces the BullMQ `ticketQueue.add()` pattern. Instead, it:
1. Creates a `run_attempts` DB row
2. Links the run to the ticket via `currentRunId`
3. Starts the durable workflow via `workflow/api`'s `start()` function
4. Stores the `workflowRunId` for cancellation

```ts
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { db, runAttempts, tickets, createLogger } from "@blazebot/shared";
import { teardownContainer } from "../sandbox/manager.js";

const logger = createLogger();

export async function startWorkflowRun(options: {
  ticketRowId: string;
  ticketExternalId: string;
  type: "implementation" | "review_fix";
  branchName?: string;
  workflow: (...args: any[]) => any;
  workflowArgs: any[];
  dedupeId: string;
}): Promise<string> {
  const [run] = await db
    .insert(runAttempts)
    .values({
      ticketId: options.ticketRowId,
      type: options.type,
      status: "pending",
      branchName: options.branchName,
    })
    .returning();

  await db
    .update(tickets)
    .set({ currentRunId: run!.id, updatedAt: new Date() })
    .where(eq(tickets.id, options.ticketRowId));

  const handle = await start(options.workflow, [...options.workflowArgs, run!.id], {
    id: options.dedupeId,
  });

  await db
    .update(runAttempts)
    .set({ workflowRunId: handle.runId })
    .where(eq(runAttempts.id, run!.id));

  logger.info({
    ticketId: options.ticketExternalId,
    runAttemptId: run!.id,
    workflowRunId: handle.runId,
    type: options.type,
  }, "workflow_run_started");

  return run!.id;
}

export async function cancelWorkflowRun(options: {
  runAttemptId: string;
  workflowRunId: string | null;
  containerId: string | null;
  ticketExternalId: string;
}): Promise<void> {
  // 1. Cancel at the workflow framework level
  if (options.workflowRunId) {
    try {
      const world = getWorld();
      await world.events.create(options.workflowRunId, {
        eventType: "run_cancelled",
        specVersion: 2,
      });
    } catch (err) {
      logger.warn({
        ticketId: options.ticketExternalId,
        workflowRunId: options.workflowRunId,
        error: (err as Error).message,
      }, "workflow_cancel_failed");
    }
  }

  // 2. Teardown the container
  if (options.containerId) {
    try {
      await teardownContainer(options.containerId);
    } catch (err) {
      logger.warn({
        ticketId: options.ticketExternalId,
        containerId: options.containerId,
        error: (err as Error).message,
      }, "container_teardown_failed");
    }
  }

  // 3. Mark run as cancelled
  await db
    .update(runAttempts)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(runAttempts.id, options.runAttemptId));
}
```

**Step 2: Create webhook-router.ts**

Same state machine logic as the old BullMQ router, but dispatches durable workflows instead of queue jobs:

- **New ticket → AI column**: Insert ticket row, `startWorkflowRun(implementTicket, ...)`
- **Clarification resumed**: Update state to queued, `startWorkflowRun(implementTicket, ...)`
- **Awaiting review → AI column**: Start `reviewFixTicket` workflow
- **Failed → AI column**: Retry with `implementTicket`
- **Moved out of AI**: `cancelWorkflowRun()` then mark as failed
- **Duplicate / self-transition**: Ignored with log

Key changes from old router:
- No `ticketQueue.add()` — replaced with `startWorkflowRun()`
- No `teardownContainer()` inline — replaced with `cancelWorkflowRun()` which cancels framework-level + tears down container
- Deduplication via `dedupeId` passed to workflow framework's `start()` function

**Step 3: Commit**

```
feat: add webhook router with durable workflow integration
```

---

### Task 5: Implement durable workflows

**Files:**
- Create: `packages/app/src/workflows/implementation.ts`
- Create: `packages/app/src/workflows/review-fix.ts`
- Create: `packages/app/src/workflows/maintenance.ts`

**Step 1: Create implementation.ts**

The `implementTicket` workflow replaces the old BullMQ `processImplementation` handler. Uses `"use workflow"` directive for the orchestrator and `"use step"` for each unit of work:

**Orchestrator** (`"use workflow"`):
```
implementTicket(ticketId, source, triggeredBy, runAttemptId)
  1. fetchAndValidateTicket — verify ticket still in AI column (stale job protection)
  2. setupBranch — create git branch, update ticket to "implementing"
  3. executeSandbox — run Claude Code in Docker container
  4. recordContainerId — store container ID for cancellation
  5. pushAndTeardown — push commits from container, tear down
  6. createPullRequest — create GitHub PR
  7. finalizeSuccess / finalizeClarification / finalizeFailure
```

Each step is a separate function with `"use step"` — the framework persists completion of each step, so if the process crashes mid-workflow, it resumes from the last completed step.

Key design decisions:
- `FatalError` (from `workflow` module) used for non-retryable failures (e.g., "No commits between branches")
- Regular `throw new Error()` for retryable failures
- `pushAndTeardown` uses try/finally to ensure container cleanup even if push fails

**Step 2: Create review-fix.ts**

The `reviewFixTicket` workflow handles PR review feedback:

```
reviewFixTicket(ticketId, source, triggeredBy, runAttemptId)
  1. validateReviewFix — verify ticket in AI column, extract prId/branchName from DB
  2. executeFixSandbox — fetch PR comments + conflict status, run sandbox
  3. pushAndTeardown / teardownStep
  4. finalizeFixSuccess / finalizeFixFailure
```

Differences from implementation workflow:
- State transitions to `fixing_feedback` instead of `implementing`
- Fetches PR comments and conflict status before sandbox execution
- Uses `review-fix.md` prompt template
- No clarification path — only success or failure

**Step 3: Create maintenance.ts**

The `maintenanceLoop` workflow replaces the BullMQ repeatable job:

```
maintenanceLoop()
  while (true):
    pollOnce()
    sleep(POLL_INTERVAL_MS)
```

`pollOnce` step runs two checks in parallel:
- **checkMissedWebhooks**: JQL search for tickets in AI column not tracked in DB → create and start implementation
- **checkStuckJobs**: Find tickets stuck in `implementing`/`fixing_feedback` past threshold → cancel, re-enqueue or mark exhausted

Key differences from old poller:
- Uses `sleep()` from `workflow` module (durable sleep — survives process restart)
- Uses `startWorkflowRun()` / `cancelWorkflowRun()` instead of BullMQ queue operations
- No Redis/BullMQ dependency

**Step 4: Commit**

```
feat: implement durable workflows for implementation, review-fix, and maintenance
```

---

### Task 6: Create Nitro plugins for lifecycle management

**Files:**
- Create: `packages/app/src/plugins/workflow-world.ts`
- Create: `packages/app/src/plugins/maintenance.ts`
- Create: `packages/app/src/plugins/orphan-cleanup.ts`

**Step 1: Create workflow-world.ts**

Starts the workflow runtime on server boot:

```ts
import { definePlugin } from "nitro";
import { getWorld } from "workflow/runtime";

export default definePlugin(async () => {
  await getWorld().start();
});
```

**Step 2: Create maintenance.ts**

On startup, cancels any stale `maintenanceLoop` runs (from previous process), then starts a fresh one:

```ts
import { definePlugin } from "nitro";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { maintenanceLoop } from "../workflows/maintenance.js";
import { createLogger } from "@blazebot/shared";

const logger = createLogger();

async function cancelStaleRuns() {
  const workflowName = (maintenanceLoop as unknown as { workflowId: string }).workflowId;
  const world = getWorld();
  const [running, pending] = await Promise.all([
    world.runs.list({ workflowName, status: "running", resolveData: "all" }),
    world.runs.list({ workflowName, status: "pending", resolveData: "all" }),
  ]);
  const staleRuns = [...running.data, ...pending.data];
  await Promise.all(
    staleRuns.map((run) =>
      world.events.create(run.runId, {
        eventType: "run_cancelled",
        specVersion: run.specVersion ?? 1,
      }),
    ),
  );
  if (staleRuns.length > 0) {
    logger.info({ count: staleRuns.length }, "maintenance_loop_cancelled_stale");
  }
}

export default definePlugin(async () => {
  await cancelStaleRuns();
  await start(maintenanceLoop, []);
  logger.info("maintenance_loop_started");
});
```

**Step 3: Create orphan-cleanup.ts**

```ts
import { definePlugin } from "nitro";
import { cleanupOrphanContainers } from "../sandbox/manager.js";

export default definePlugin(async () => {
  await cleanupOrphanContainers();
});
```

**Step 4: Commit**

```
feat: add Nitro plugins for workflow lifecycle and container cleanup
```

---

### Task 7: Add workflow cancellation support

**Files:**
- Modify: `packages/app/src/lib/webhook-router.ts`
- Modify: `packages/app/src/lib/workflow-helpers.ts`
- Modify: `packages/app/src/workflows/maintenance.ts`
- Modify: `packages/shared/src/schema.ts`

**Step 1: Add `cancelled` to run_status enum**

In `packages/shared/src/schema.ts`, add `"cancelled"` to the `runStatusEnum`:

```ts
export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "preparing_sandbox",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "clarification_needed",
  "cancelled",
]);
```

Generate migration: `pnpm db:generate`

**Step 2: Implement cancelWorkflowRun in workflow-helpers.ts**

Three-phase cancellation:
1. Send `run_cancelled` event to workflow framework via `world.events.create()`
2. Teardown Docker container via `teardownContainer()`
3. Update `run_attempts` record to `cancelled`

Each phase has error handling — cancellation is best-effort (run may already be terminal, container may already be gone).

**Step 3: Wire cancellation into webhook-router.ts**

In `handleMovedOutOfAi()`:
- Look up active run via `ticket.currentRunId` → `runAttempts` row
- Call `cancelWorkflowRun()` with `workflowRunId` and `containerId`
- Mark ticket as `failed`

**Step 4: Wire cancellation into maintenance.ts**

In `checkStuckJobs()`:
- Call `cancelWorkflowRun()` before re-enqueueing
- Override status to `timed_out` (stuck ≠ user-cancelled)

**Step 5: Add stale maintenance run cancellation to plugin**

The maintenance plugin cancels any lingering `maintenanceLoop` workflow runs from previous server instances before starting a fresh one, using `world.runs.list()` + `world.events.create()`.

**Step 6: Commit**

```
feat: add workflow cancellation support for contradicting webhooks and stuck jobs
```

---

### Task 8: Remove old API and Worker packages

**Files:**
- Delete: `packages/api/` (entire directory)
- Delete: `packages/worker/` (entire directory)
- Modify: `docker-compose.yml`
- Modify: `package.json` (root)
- Modify: `.env.example`

**Step 1: Remove packages/api/**

The API functionality (Fastify server, webhook handling, routing) has been absorbed into `packages/app` via Nitro routes.

**Step 2: Remove packages/worker/**

The worker functionality (BullMQ worker, poller, sandbox, context) has been absorbed into `packages/app` via durable workflows.

**Step 3: Clean up shared package**

Remove from `@blazebot/shared`:
- `redis.ts` — no longer needed (no BullMQ)
- `queue.ts` — no longer needed (no BullMQ)
- `env.ts` shared env — remove `REDIS_URL` and queue-related vars
- Update `index.ts` barrel to remove queue/redis exports

**Step 4: Update docker-compose.yml**

Remove `redis` service (no longer needed). Single `app` service replaces `api` + `worker`:

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

  app:
    build:
      context: .
      dockerfile: packages/app/Dockerfile
    ports:
      - "${PORT:-3000}:3000"
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      postgres: { condition: service_healthy }

volumes:
  postgres_data:
```

**Step 5: Update .env.example**

Remove `REDIS_URL`. Add `WORKFLOW_POSTGRES_URL` (same as `DATABASE_URL` — used by workflow module).

**Step 6: Update root package.json scripts**

Replace `start:api`/`start:worker` with single `start` and `dev` commands:

```json
{
  "scripts": {
    "dev": "pnpm --filter @blazebot/app dev",
    "build": "pnpm -r build",
    "start": "pnpm --filter @blazebot/app start",
    "test": "pnpm -r test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push"
  }
}
```

**Step 7: Commit**

```
refactor: remove API and Worker packages, consolidate into single Nitro app
```

---

## Architecture Comparison

### Before (BullMQ + Fastify)
```
┌─────────────────────────────┐      ┌────────────────────────────┐
│ @blazebot/api               │      │ @blazebot/worker           │
│ Fastify server              │      │ BullMQ worker              │
│ POST /webhooks/jira         │─────>│ processJob()               │
│ routeTicketTransition()     │ via  │ processImplementation()    │
│                             │ Redis│ processReviewFix()         │
│                             │      │ poller (repeatable job)    │
└─────────────────────────────┘      └────────────────────────────┘
        │                                       │
        └──────────── Redis (BullMQ) ──────────┘
```

### After (Nitro + Durable Workflows)
```
┌───────────────────────────────────────────────────────┐
│ @blazebot/app (single Nitro process)                  │
│                                                       │
│ Routes:                                               │
│   POST /webhooks/jira → routeTicketTransition()       │
│   GET /health                                         │
│                                                       │
│ Workflows (durable, persisted to Postgres):           │
│   implementTicket()   — "use workflow" / "use step"   │
│   reviewFixTicket()   — "use workflow" / "use step"   │
│   maintenanceLoop()   — infinite workflow with sleep() │
│                                                       │
│ Plugins (run on startup):                             │
│   workflow-world  — start workflow runtime             │
│   maintenance     — cancel stale + start fresh loop   │
│   orphan-cleanup  — remove dangling Docker containers │
└───────────────────────────────────────────────────────┘
        │
        └──────────── PostgreSQL (workflow state + app data) ──────────┘
```

### Key Benefits
- **No Redis dependency** — workflow state persisted to Postgres
- **Single process** — simpler deployment, no inter-process coordination
- **Crash recovery** — durable workflows resume from last completed step
- **Built-in cancellation** — framework-level event system for stopping workflows
- **Durable sleep** — maintenance polling survives restarts without repeatable job setup
