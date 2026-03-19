# Monorepo Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure Blazebot from a single-package app into a pnpm workspaces monorepo with `@blazebot/api`, `@blazebot/worker`, and `@blazebot/shared` packages.

**Architecture:** API and Worker become independent entry points communicating only through a Redis-backed BullMQ queue. Shared code (DB, adapters, queue, env) lives in a library package imported by both. The current `src/index.ts` is split: Fastify server goes to API, BullMQ worker + poller + cleanup go to Worker.

**Tech Stack:** pnpm workspaces, TypeScript project references, multi-stage Docker builds

**Spec:** `docs/superpowers/specs/2026-03-19-monorepo-migration-design.md`

---

### Task 1: Create workspace scaffolding

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Modify: `package.json` (root)

- [ ] **Step 1: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create tsconfig.base.json**

Extract shared compiler options from the current `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true
  }
}
```

- [ ] **Step 3: Update root package.json**

Replace the current root `package.json` with workspace-level config:

```json
{
  "name": "blazebot",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "start:api": "pnpm --filter @blazebot/api start",
    "start:worker": "pnpm --filter @blazebot/worker start",
    "test": "pnpm -r test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "inspect": "bash scripts/inspect.sh"
  },
  "packageManager": "pnpm@10.22.0",
  "devDependencies": {
    "drizzle-kit": "^0.31.9",
    "typescript": "~5.9.3"
  }
}
```

- [ ] **Step 4: Create package directory structure**

```bash
mkdir -p packages/shared/src/adapters
mkdir -p packages/api/src/webhooks
mkdir -p packages/worker/src/sandbox
```

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml tsconfig.base.json package.json
git commit -m "chore: scaffold pnpm workspace and base tsconfig"
```

---

### Task 2: Create @blazebot/shared package

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Move: `src/logger.ts` → `packages/shared/src/logger.ts`
- Move: `src/schema.ts` → `packages/shared/src/schema.ts`
- Move: `src/db.ts` → `packages/shared/src/db.ts`
- Move: `src/redis.ts` → `packages/shared/src/redis.ts`
- Move: `src/queue.ts` → `packages/shared/src/queue.ts`
- Move: `src/adapters/messaging.ts` → `packages/shared/src/adapters/messaging.ts`
- Move: `src/adapters/noop-messaging.ts` → `packages/shared/src/adapters/noop-messaging.ts`
- Move: `src/adapters/console-messaging.ts` → `packages/shared/src/adapters/console-messaging.ts`
- Move: `src/adapters/slack-messaging.ts` → `packages/shared/src/adapters/slack-messaging.ts`
- Move: `src/adapters/messaging-factory.ts` → `packages/shared/src/adapters/messaging-factory.ts`
- Move: `src/adapters/ticket.ts` → `packages/shared/src/adapters/ticket.ts`
- Move: `src/adapters/source-control.ts` → `packages/shared/src/adapters/source-control.ts`
- Move: `src/adapters/jira-client.ts` → `packages/shared/src/adapters/jira-client.ts`
- Move: `src/adapters/github-client.ts` → `packages/shared/src/adapters/github-client.ts`
- Create: `packages/shared/src/adapters/jira-webhook-parser.ts` (extracted from `src/webhooks/jira.ts`)
- Create: `packages/shared/src/index.ts` (barrel export)
- Move tests: all shared test files

- [ ] **Step 1: Create packages/shared/package.json**

```json
{
  "name": "@blazebot/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./*": "./dist/*.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest"
  },
  "dependencies": {
    "@octokit/rest": "^22.0.1",
    "@slack/web-api": "^7.15.0",
    "@t3-oss/env-core": "^0.13.10",
    "bullmq": "^5.71.0",
    "drizzle-orm": "~0.45.1",
    "ioredis": "^5.9.3",
    "pino": "^10.3.1",
    "postgres": "~3.4.8",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^25.4.0",
    "tsx": "^4.21.0",
    "typescript": "~5.9.3",
    "vitest": "^4.0.18"
  }
}
```

- [ ] **Step 2: Create packages/shared/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create packages/shared/vitest.config.ts**

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

- [ ] **Step 4: Move shared source files**

Move the following files from `src/` to `packages/shared/src/`:

```bash
mv src/logger.ts packages/shared/src/logger.ts
mv src/schema.ts packages/shared/src/schema.ts
mv src/db.ts packages/shared/src/db.ts
mv src/redis.ts packages/shared/src/redis.ts
mv src/queue.ts packages/shared/src/queue.ts
mv src/adapters/messaging.ts packages/shared/src/adapters/messaging.ts
mv src/adapters/noop-messaging.ts packages/shared/src/adapters/noop-messaging.ts
mv src/adapters/console-messaging.ts packages/shared/src/adapters/console-messaging.ts
mv src/adapters/slack-messaging.ts packages/shared/src/adapters/slack-messaging.ts
mv src/adapters/messaging-factory.ts packages/shared/src/adapters/messaging-factory.ts
mv src/adapters/ticket.ts packages/shared/src/adapters/ticket.ts
mv src/adapters/source-control.ts packages/shared/src/adapters/source-control.ts
mv src/adapters/jira-client.ts packages/shared/src/adapters/jira-client.ts
mv src/adapters/github-client.ts packages/shared/src/adapters/github-client.ts
```

No import path changes needed for these files — their internal relative imports stay the same (e.g., `./messaging.js`, `../logger.js`).

- [ ] **Step 5: Extract parseJiraWebhook into shared**

The current `src/webhooks/jira.ts` has two functions:
- `verifyJiraWebhookSignature` — only used by API (stays in API)
- `parseJiraWebhook` — used by both API webhook handler and `JiraClient.parseWebhook()` (moves to shared)

Create `packages/shared/src/adapters/jira-webhook-parser.ts`:

```ts
import { z } from "zod";
import type { NormalizedEvent } from "./ticket.js";

const changelogItemSchema = z.object({
  field: z.string(),
  fieldtype: z.string(),
  fromString: z
    .string()
    .nullable()
    .transform((v) => v ?? ""),
  toString: z.string(),
});

const jiraWebhookSchema = z.object({
  user: z.object({
    accountId: z.string(),
    displayName: z.string(),
  }),
  issue: z.object({
    key: z.string(),
  }),
  changelog: z.object({
    items: z.array(changelogItemSchema),
  }),
});

export function parseJiraWebhook(body: unknown): NormalizedEvent | null {
  const parsed = jiraWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }

  const { user, issue, changelog } = parsed.data;
  const statusChange = changelog.items.find((item) => item.field === "status");

  if (!statusChange) {
    return null;
  }

  return {
    type: "ticket_moved",
    ticketId: issue.key,
    fromColumn: statusChange.fromString,
    toColumn: statusChange.toString,
    triggeredBy: user.displayName,
    triggeredByAccountId: user.accountId,
  };
}
```

- [ ] **Step 6: Update jira-client.ts import**

In `packages/shared/src/adapters/jira-client.ts`, change:

```ts
// OLD
import { parseJiraWebhook } from "../webhooks/jira.js";

// NEW
import { parseJiraWebhook } from "./jira-webhook-parser.js";
```

- [ ] **Step 7: Create barrel export**

Create `packages/shared/src/index.ts`:

```ts
// Config
export { env } from "./env.js";
export { db } from "./db.js";
export { createRedisConnection } from "./redis.js";
export { createLogger, createTicketLogger, createRunLogger } from "./logger.js";
export type { Logger } from "./logger.js";

// Schema
export {
  tickets,
  runAttempts,
  ticketSourceEnum,
  workflowStateEnum,
  runStatusEnum,
  runTypeEnum,
} from "./schema.js";

// Queue
export { ticketQueue, maintenanceQueue, defaultJobOptions } from "./queue.js";
export type { TicketJobData } from "./queue.js";

// Adapters
export type { MessagingAdapter } from "./adapters/messaging.js";
export type {
  TicketAdapter,
  Ticket,
  TicketComment,
  NormalizedEvent,
} from "./adapters/ticket.js";
export type {
  VCSAdapter,
  PullRequest,
  PullRequestComment,
} from "./adapters/source-control.js";
export { JiraClient } from "./adapters/jira-client.js";
export { GitHubClient } from "./adapters/github-client.js";
export { createMessagingAdapter } from "./adapters/messaging-factory.js";
export { parseJiraWebhook } from "./adapters/jira-webhook-parser.js";
```

- [ ] **Step 8: Move shared test files**

```bash
mv src/logger.test.ts packages/shared/src/logger.test.ts
mv src/schema.test.ts packages/shared/src/schema.test.ts
mv src/redis.test.ts packages/shared/src/redis.test.ts
mv src/queue.test.ts packages/shared/src/queue.test.ts
mv src/adapters/slack-messaging.test.ts packages/shared/src/adapters/slack-messaging.test.ts
mv src/adapters/noop-messaging.test.ts packages/shared/src/adapters/noop-messaging.test.ts
mv src/adapters/messaging-factory.test.ts packages/shared/src/adapters/messaging-factory.test.ts
mv src/adapters/jira-client.test.ts packages/shared/src/adapters/jira-client.test.ts
mv src/adapters/github-client.test.ts packages/shared/src/adapters/github-client.test.ts
```

Update the `jira-client.test.ts` if it imports from `../webhooks/jira.js` — that import should now come from `./jira-webhook-parser.js` or from the barrel.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/
git commit -m "feat: create @blazebot/shared package with adapters, schema, and queue"
```

---

### Task 3: Split env.ts into per-package schemas

**Files:**
- Modify: `packages/shared/src/env.ts` (move from `src/env.ts` and strip to shared-only vars)
- Create: `packages/api/src/env.ts` (API-specific vars)
- Create: `packages/worker/src/env.ts` (Worker-specific vars)

The current `env.ts` uses `@t3-oss/env-core` which eagerly validates ALL declared vars on import. A single schema would crash the API because `CLAUDE_CODE_OAUTH_TOKEN` (required, no default) isn't set in API's environment.

- [ ] **Step 1: Move env.ts to shared and strip to base vars**

Move `src/env.ts` → `packages/shared/src/env.ts` and replace contents:

```ts
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    COLUMN_AI: z.string().default("AI"),
    COLUMN_AI_REVIEW: z.string().default("AI Review"),
    COLUMN_BACKLOG: z.string().default("Backlog"),
    ISSUE_TRACKER_KIND: z.enum(["jira", "linear"]).default("jira"),
    MESSAGING_KIND: z.enum(["slack"]).default("slack"),
    SLACK_BOT_TOKEN: z.string().min(1).optional(),
    SLACK_DEFAULT_CHANNEL: z.string().min(1).optional(),
    VCS_KIND: z.enum(["github"]).default("github"),
    JOB_MAX_RETRIES: z
      .string()
      .default("3")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().nonnegative()),
    JOB_BACKOFF_MS: z
      .string()
      .default("30000")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
  },
  runtimeEnv: process.env,
});
```

- [ ] **Step 2: Create API env.ts**

Create `packages/api/src/env.ts`:

```ts
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const apiEnv = createEnv({
  server: {
    PORT: z
      .string()
      .default("3000")
      .transform((v) => parseInt(v, 10)),
    JIRA_WEBHOOK_SECRET: z.string().min(1),
  },
  runtimeEnv: process.env,
});
```

API code imports `env` from `@blazebot/shared` for shared vars, and `apiEnv` from `./env.js` for API-specific vars.

- [ ] **Step 3: Create Worker env.ts**

Create `packages/worker/src/env.ts`:

```ts
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const workerEnv = createEnv({
  server: {
    MAX_CONCURRENT_AGENTS: z
      .string()
      .default("3")
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
    CLAUDE_MODEL: z.string().default("claude-opus-4-20250514"),
    DOCKER_IMAGE: z.string().default("blazebot-sandbox"),
    SANDBOX_MEMORY_MB: z
      .string()
      .default("4096")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    DEVELOPER_MODE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    JOB_TIMEOUT_MS: z
      .string()
      .default("600000")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    POLL_INTERVAL_MS: z
      .string()
      .default("300000")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    STUCK_JOB_THRESHOLD_MS: z
      .string()
      .optional()
      .transform((v) => (v ? parseInt(v, 10) : undefined))
      .pipe(z.number().int().positive().optional()),
  },
  runtimeEnv: process.env,
});
```

- [ ] **Step 4: Move env.test.ts to shared and update**

Move `src/env.test.ts` → `packages/shared/src/env.test.ts`. Update test imports if needed — tests should validate the shared env schema. Create separate test files for API/Worker env if needed in their respective packages.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/env.ts packages/api/src/env.ts packages/worker/src/env.ts
git commit -m "feat: split env validation into per-package schemas"
```

---

### Task 4: Create @blazebot/api package

**Files:**
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/vitest.config.ts`
- Create: `packages/api/src/index.ts` (Fastify server only)
- Create: `packages/api/src/webhooks/jira.ts` (verifyJiraWebhookSignature only)
- Move: `src/webhooks/router.ts` → `packages/api/src/webhooks/router.ts`
- Move: `src/webhooks/types.ts` → `packages/api/src/webhooks/types.ts`

- [ ] **Step 1: Create packages/api/package.json**

```json
{
  "name": "@blazebot/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch --env-file=../../.env src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest"
  },
  "dependencies": {
    "@blazebot/shared": "workspace:*",
    "@t3-oss/env-core": "^0.13.10",
    "drizzle-orm": "~0.45.1",
    "fastify": "^5.8.2",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^25.4.0",
    "tsx": "^4.21.0",
    "typescript": "~5.9.3",
    "vitest": "^4.0.18"
  }
}
```

- [ ] **Step 2: Create packages/api/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"],
  "references": [
    { "path": "../shared" }
  ]
}
```

- [ ] **Step 3: Create packages/api/vitest.config.ts**

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

- [ ] **Step 4: Create packages/api/src/webhooks/jira.ts**

Only `verifyJiraWebhookSignature` stays in the API. `parseJiraWebhook` was extracted to shared.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyJiraWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

- [ ] **Step 5: Move webhooks/types.ts**

Move `src/webhooks/types.ts` → `packages/api/src/webhooks/types.ts`.

Update the import path:

```ts
// OLD
export type { NormalizedEvent } from "../adapters/ticket.js";

// NEW
export type { NormalizedEvent } from "@blazebot/shared";
```

- [ ] **Step 6: Move and update webhooks/router.ts**

Move `src/webhooks/router.ts` → `packages/api/src/webhooks/router.ts`.

Update all imports to use `@blazebot/shared` and replace the `teardownContainer` call with a cancellation job:

```ts
import { eq, and } from "drizzle-orm";
import {
  env,
  db,
  tickets,
  runAttempts,
  ticketQueue,
  createLogger,
} from "@blazebot/shared";
import type { NormalizedEvent } from "./types.js";

const logger = createLogger();

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function routeTicketTransition(
  event: NormalizedEvent,
): Promise<void> {
  const to = normalize(event.toColumn);
  const from = normalize(event.fromColumn);
  const colAi = normalize(env.COLUMN_AI);

  if (to === colAi) {
    await handleMovedToAi(event);
    return;
  }

  if (from === colAi || isAiRelatedColumn(from)) {
    await handleMovedOutOfAi(event);
    return;
  }
}

function isAiRelatedColumn(col: string): boolean {
  const aiColumns = [normalize(env.COLUMN_AI), normalize(env.COLUMN_AI_REVIEW)];
  return aiColumns.includes(col);
}

// handleMovedToAi — unchanged logic, same as current code

// handleMovedOutOfAi — replace teardownContainer with cancellation job:
// Instead of:
//   await teardownContainer(activeRun.containerId);
// Use:
//   await ticketQueue.add("cancellation", {
//     type: "cancellation",
//     ticketId: event.ticketId,
//     containerId: activeRun.containerId,
//     source: "jira",
//     triggeredBy: event.triggeredBy,
//   });
```

**Important:** The full `handleMovedToAi` and `handleMovedOutOfAi` functions keep identical logic to the current `router.ts`. The ONLY change is in `handleMovedOutOfAi`: replace the `teardownContainer(activeRun.containerId)` call (lines 260-261 of current file) with a queue job enqueue. Also add `"cancellation"` to the `TicketJobData` union type in shared's `queue.ts`.

- [ ] **Step 7: Update TicketJobData type in shared queue.ts**

In `packages/shared/src/queue.ts`, add the cancellation job type:

```ts
export type TicketJobData =
  | {
      type: "implementation";
      ticketId: string;
      source: "jira" | "linear";
      triggeredBy: string;
    }
  | {
      type: "review_fix";
      ticketId: string;
      source: "jira" | "linear";
      triggeredBy: string;
    }
  | {
      type: "cancellation";
      ticketId: string;
      containerId: string;
      source: "jira" | "linear";
      triggeredBy: string;
    };
```

- [ ] **Step 8: Create packages/api/src/index.ts**

The API's entry point — only the Fastify server. No worker, no poller, no cleanup.

```ts
import Fastify from "fastify";
import { env, createLogger, parseJiraWebhook } from "@blazebot/shared";
import { apiEnv } from "./env.js";
import { verifyJiraWebhookSignature } from "./webhooks/jira.js";
import { routeTicketTransition } from "./webhooks/router.js";

const logger = createLogger();

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function buildApp() {
  const app = Fastify({ logger: true });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString()));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.post("/webhooks/jira", async (request, reply) => {
    if (!request.rawBody) {
      logger.warn({ path: "/webhooks/jira" }, "webhook_validation_failed");
      return reply.code(401).send({ error: "invalid signature" });
    }
    const rawSignature = request.headers["x-hub-signature"];
    const signature = Array.isArray(rawSignature)
      ? rawSignature[0]
      : rawSignature;
    const valid = verifyJiraWebhookSignature(
      request.rawBody,
      signature,
      apiEnv.JIRA_WEBHOOK_SECRET,
    );
    if (!valid) {
      logger.warn({ path: "/webhooks/jira" }, "webhook_validation_failed");
      return reply.code(401).send({ error: "invalid signature" });
    }

    const event = parseJiraWebhook(request.body);
    if (event) {
      logger.info(
        {
          ticketId: event.ticketId,
          type: event.type,
          triggeredBy: event.triggeredBy,
        },
        "webhook_received",
      );
      await routeTicketTransition(event);
    }
    return { ok: true };
  });

  return app;
}

async function main() {
  const app = buildApp();

  try {
    await app.listen({ port: apiEnv.PORT, host: "0.0.0.0" });
    logger.info({ port: apiEnv.PORT }, "server_started");
  } catch (err) {
    logger.error(err, "server_start_failed");
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info("shutdown_initiated");
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

- [ ] **Step 9: Move webhook tests**

```bash
mv src/webhooks/jira.test.ts packages/api/src/webhooks/jira.test.ts
mv src/webhooks/router.test.ts packages/api/src/webhooks/router.test.ts
```

Update imports in both test files:
- `jira.test.ts`: the `parseJiraWebhook` tests go with shared (move to `packages/shared/src/adapters/jira-webhook-parser.test.ts`). The `verifyJiraWebhookSignature` tests stay in the API's `jira.test.ts`.
- `router.test.ts`: update to import from `@blazebot/shared` instead of relative paths. Remove teardownContainer mock, add cancellation queue mock.

Read the current test files before updating to ensure accuracy.

- [ ] **Step 10: Move index.test.ts**

Move `src/index.test.ts` → `packages/api/src/index.test.ts`. Update imports.

- [ ] **Step 11: Commit**

```bash
git add packages/api/
git commit -m "feat: create @blazebot/api package with Fastify server and webhook handling"
```

---

### Task 5: Create @blazebot/worker package

**Files:**
- Create: `packages/worker/package.json`
- Create: `packages/worker/tsconfig.json`
- Create: `packages/worker/vitest.config.ts`
- Create: `packages/worker/src/index.ts` (worker entry point)
- Move: `src/worker.ts` → `packages/worker/src/worker.ts`
- Move: `src/poller.ts` → `packages/worker/src/poller.ts`
- Move: `src/context.ts` → `packages/worker/src/context.ts`
- Move: `src/sandbox/manager.ts` → `packages/worker/src/sandbox/manager.ts`
- Move: `prompts/` → `packages/worker/prompts/`

- [ ] **Step 1: Create packages/worker/package.json**

```json
{
  "name": "@blazebot/worker",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch --env-file=../../.env src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest"
  },
  "dependencies": {
    "@blazebot/shared": "workspace:*",
    "@t3-oss/env-core": "^0.13.10",
    "bullmq": "^5.71.0",
    "dockerode": "^4.0.9",
    "drizzle-orm": "~0.45.1",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/dockerode": "^3.3.26",
    "@types/node": "^25.4.0",
    "tsx": "^4.21.0",
    "typescript": "~5.9.3",
    "vitest": "^4.0.18"
  }
}
```

- [ ] **Step 2: Create packages/worker/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"],
  "references": [
    { "path": "../shared" }
  ]
}
```

- [ ] **Step 3: Create packages/worker/vitest.config.ts**

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

- [ ] **Step 4: Move worker source files**

```bash
mv src/worker.ts packages/worker/src/worker.ts
mv src/poller.ts packages/worker/src/poller.ts
mv src/context.ts packages/worker/src/context.ts
mv src/sandbox/manager.ts packages/worker/src/sandbox/manager.ts
```

- [ ] **Step 5: Move prompts/ into worker package**

Only the worker reads prompt files. Move them so the path resolution works:

```bash
mv prompts packages/worker/prompts
```

- [ ] **Step 6: Update worker.ts imports**

Replace all relative `./` imports with `@blazebot/shared` imports, and use `workerEnv` for worker-specific vars:

```ts
import { Worker, Job } from "bullmq";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  env,
  db,
  tickets,
  runAttempts,
  createRedisConnection,
  JiraClient,
  GitHubClient,
  createMessagingAdapter,
  createLogger,
  createTicketLogger,
  createRunLogger,
} from "@blazebot/shared";
import type { TicketJobData } from "@blazebot/shared";
import { workerEnv } from "./env.js";
import {
  runSandbox,
  pushBranchFromContainer,
  teardownContainer,
} from "./sandbox/manager.js";
import {
  assembleImplementationContext,
  assembleFixingFeedbackContext,
} from "./context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "..", "prompts");
```

Then throughout the file, replace:
- `env.JIRA_BASE_URL` → `workerEnv.JIRA_BASE_URL`
- `env.JIRA_USER_EMAIL` → `workerEnv.JIRA_USER_EMAIL`
- `env.JIRA_API_TOKEN` → `workerEnv.JIRA_API_TOKEN`
- `env.GITHUB_TOKEN` → `workerEnv.GITHUB_TOKEN`
- `env.CLAUDE_CODE_OAUTH_TOKEN` → `workerEnv.CLAUDE_CODE_OAUTH_TOKEN`
- `env.CLAUDE_MODEL` → `workerEnv.CLAUDE_MODEL`
- `env.DOCKER_IMAGE` → `workerEnv.DOCKER_IMAGE`
- `env.SANDBOX_MEMORY_MB` → `workerEnv.SANDBOX_MEMORY_MB`
- `env.DEVELOPER_MODE` → `workerEnv.DEVELOPER_MODE`
- `env.JOB_TIMEOUT_MS` → `workerEnv.JOB_TIMEOUT_MS`
- `env.MAX_CONCURRENT_AGENTS` → `workerEnv.MAX_CONCURRENT_AGENTS`
- `env.GITHUB_REPO_OWNER` → `workerEnv.GITHUB_REPO_OWNER`
- `env.GITHUB_REPO_NAME` → `workerEnv.GITHUB_REPO_NAME`
- `env.GITHUB_BASE_BRANCH` → `workerEnv.GITHUB_BASE_BRANCH`
- Shared vars like `env.COLUMN_AI`, `env.COLUMN_AI_REVIEW`, `env.COLUMN_BACKLOG`, `env.MESSAGING_KIND` stay as `env.X`

Also add a handler for the `cancellation` job type in the job router:

```ts
if (job.data.type === "cancellation") {
  await teardownContainer(job.data.containerId);
  logger.info(
    { ticketId: job.data.ticketId, containerId: job.data.containerId },
    "container_teardown",
  );
  return;
}
```

- [ ] **Step 7: Update poller.ts imports**

Same pattern — replace relative imports with `@blazebot/shared` and `workerEnv`:

```ts
import { eq, and, inArray, lt } from "drizzle-orm";
import {
  env,
  db,
  tickets,
  runAttempts,
  ticketQueue,
  defaultJobOptions,
  JiraClient,
  createMessagingAdapter,
  createLogger,
} from "@blazebot/shared";
import { workerEnv } from "./env.js";
import { teardownContainer } from "./sandbox/manager.js";
```

Replace:
- `env.JIRA_PROJECT_KEY` → `workerEnv.JIRA_PROJECT_KEY`
- `env.JIRA_BASE_URL` → `workerEnv.JIRA_BASE_URL`
- `env.JIRA_USER_EMAIL` → `workerEnv.JIRA_USER_EMAIL`
- `env.JIRA_API_TOKEN` → `workerEnv.JIRA_API_TOKEN`
- `env.STUCK_JOB_THRESHOLD_MS` → `workerEnv.STUCK_JOB_THRESHOLD_MS`
- `env.JOB_TIMEOUT_MS` → `workerEnv.JOB_TIMEOUT_MS`

- [ ] **Step 8: Update context.ts imports**

```ts
import type { PullRequestComment } from "@blazebot/shared";
import type { Ticket } from "@blazebot/shared";
```

- [ ] **Step 9: Update sandbox/manager.ts imports**

```ts
import { createLogger } from "@blazebot/shared";
```

- [ ] **Step 10: Create packages/worker/src/index.ts**

The worker entry point — BullMQ worker, maintenance poller, orphan cleanup, graceful shutdown:

```ts
import { Worker } from "bullmq";
import {
  env,
  createRedisConnection,
  maintenanceQueue,
  createLogger,
} from "@blazebot/shared";
import { workerEnv } from "./env.js";
import { createWorker } from "./worker.js";
import { cleanupOrphanContainers } from "./sandbox/manager.js";
import { runMaintenancePoll } from "./poller.js";

const logger = createLogger();

async function main() {
  await cleanupOrphanContainers();

  const worker = createWorker();

  const maintenanceWorker = new Worker(
    "maintenance",
    async () => {
      await runMaintenancePoll();
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );

  await maintenanceQueue.add(
    "poll",
    {},
    { repeat: { every: workerEnv.POLL_INTERVAL_MS } },
  );
  logger.info(
    { intervalMs: workerEnv.POLL_INTERVAL_MS },
    "maintenance_poll_scheduled",
  );

  logger.info("worker_started");

  const shutdown = async () => {
    logger.info("shutdown_initiated");
    const forceTimeout = setTimeout(() => process.exit(1), 30_000);
    forceTimeout.unref();
    await worker.close();
    await maintenanceWorker.close();
    clearTimeout(forceTimeout);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 11: Move worker test files**

```bash
mv src/worker.test.ts packages/worker/src/worker.test.ts
mv src/poller.test.ts packages/worker/src/poller.test.ts
mv src/context.test.ts packages/worker/src/context.test.ts
mv src/sandbox/manager.test.ts packages/worker/src/sandbox/manager.test.ts
```

Update imports in all test files to use `@blazebot/shared` and `./env.js`.

- [ ] **Step 12: Commit**

```bash
git add packages/worker/
git commit -m "feat: create @blazebot/worker package with job handlers and sandbox management"
```

---

### Task 6: Clean up old src/ and update root configs

**Files:**
- Delete: `src/` (should be empty after all moves)
- Modify: `tsconfig.json` (root — convert to project references)
- Modify: `drizzle.config.ts` (update schema path)
- Modify: `vitest.config.ts` (root — delegate to packages)
- Delete: old root `tsconfig.json`

- [ ] **Step 1: Remove old src/ directory**

Verify it's empty first:

```bash
ls src/
# Should be empty or only have .env.test.ts remnants
rm -rf src/
```

- [ ] **Step 2: Replace root tsconfig.json with project references**

```json
{
  "files": [],
  "references": [
    { "path": "packages/shared" },
    { "path": "packages/api" },
    { "path": "packages/worker" }
  ]
}
```

- [ ] **Step 3: Update drizzle.config.ts**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/shared/src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 4: Remove root vitest.config.ts**

Each package now has its own vitest config. The root `pnpm test` runs `pnpm -r test` which delegates to each package.

```bash
rm vitest.config.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: clean up old src/ directory and update root configs"
```

---

### Task 7: Write Dockerfiles

**Files:**
- Create: `packages/api/Dockerfile`
- Create: `packages/worker/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Create packages/api/Dockerfile**

Multi-stage build using pnpm workspace deploy for minimal image:

```dockerfile
FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/api/package.json packages/api/tsconfig.json packages/api/
RUN pnpm install --frozen-lockfile
COPY packages/shared/src packages/shared/src
COPY packages/api/src packages/api/src
RUN pnpm -r build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api/package.json packages/api/
COPY --from=build /app/packages/api/dist packages/api/dist
RUN pnpm install --frozen-lockfile --prod
EXPOSE 3000
CMD ["node", "packages/api/dist/index.js"]
```

- [ ] **Step 2: Create packages/worker/Dockerfile**

```dockerfile
FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/worker/package.json packages/worker/tsconfig.json packages/worker/
RUN pnpm install --frozen-lockfile
COPY packages/shared/src packages/shared/src
COPY packages/worker/src packages/worker/src
COPY packages/worker/prompts packages/worker/prompts
RUN pnpm -r build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/worker/package.json packages/worker/
COPY --from=build /app/packages/worker/dist packages/worker/dist
COPY --from=build /app/packages/worker/prompts packages/worker/prompts
RUN pnpm install --frozen-lockfile --prod
CMD ["node", "packages/worker/dist/index.js"]
```

- [ ] **Step 3: Update docker-compose.yml**

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

- [ ] **Step 4: Commit**

```bash
git add packages/api/Dockerfile packages/worker/Dockerfile docker-compose.yml
git commit -m "feat: add Dockerfiles for API and Worker, update docker-compose"
```

---

### Task 8: Install dependencies and verify

- [ ] **Step 1: Install all workspace dependencies**

```bash
pnpm install
```

This generates the new `pnpm-lock.yaml` with workspace protocol links.

- [ ] **Step 2: Build all packages**

```bash
pnpm build
```

Expected: all three packages compile without TypeScript errors. If there are errors, fix import paths.

- [ ] **Step 3: Run all tests**

```bash
pnpm test
```

Expected: all tests pass. Fix any failing tests — most failures will be import path issues in test mocks.

- [ ] **Step 4: Test dev mode**

```bash
# Start infra
docker compose up postgres redis -d

# Start API + Worker
pnpm dev
```

Expected: both processes start, logs interleave. Ctrl+C stops both.

- [ ] **Step 5: Test container build**

```bash
docker compose build api worker
```

Expected: both images build successfully.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: install workspace deps and verify monorepo builds"
```
