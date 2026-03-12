# Phase 1: Infrastructure Boilerplate — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the foundational infrastructure boilerplate — Docker Compose (Postgres + Redis), Fastify health check server, Drizzle ORM config, type-safe env vars — with no business logic.

**Architecture:** Minimal flat `src/` structure. Postgres and Redis run in Docker Compose, Fastify app runs on host. Environment validated at startup via `@t3-oss/env-core` + Zod. Drizzle configured but no schema tables yet.

**Tech Stack:** Node.js 20+, TypeScript 5.9 (strict ESM), Fastify 5, Drizzle ORM 0.45, postgres 3.4, Zod 3, Vitest 4, pnpm

**Spec:** `docs/superpowers/specs/2026-03-12-phase1-boilerplate-design.md`

---

## Chunk 1: Project Scaffold

### Task 1: Initialize pnpm project and install dependencies

**Files:**
- Create: `package.json`
- Create: `.nvmrc`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `.nvmrc`**

```
20
```

- [ ] **Step 2: Initialize pnpm project**

Run: `pnpm init`

- [ ] **Step 3: Configure `package.json`**

Edit `package.json` to set ESM, engines, and scripts:

```json
{
  "name": "ai-workflow",
  "version": "0.0.1",
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push"
  }
}
```

- [ ] **Step 4: Install production dependencies**

Note: Spec uses Zod v3 (not v4 from tech stack) because `@t3-oss/env-core` requires it. Will migrate when support lands.

Run: `pnpm add fastify@5 drizzle-orm@0.45 postgres@3.4 zod@3 @t3-oss/env-core`

- [ ] **Step 5: Install dev dependencies**

Run: `pnpm add -D typescript@~5.9.0 tsx @types/node drizzle-kit vitest`

- [ ] **Step 6: Create `tsconfig.json`**

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
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 7: Create `.gitignore`**

```
node_modules/
dist/
.env
*.tsbuildinfo
# Note: drizzle/ migrations are intentionally committed for reproducibility
```

- [ ] **Step 8: Commit**

```bash
git add .nvmrc package.json pnpm-lock.yaml tsconfig.json .gitignore
git commit -m "chore: initialize pnpm project with TypeScript and dependencies"
```

---

### Task 2: Docker Compose for Postgres and Redis

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Create `docker-compose.yml`**

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

volumes:
  postgres_data:
  redis_data:
```

- [ ] **Step 2: Create `.env.example`**

```
DATABASE_URL=postgresql://blazebot:blazebot@localhost:5432/blazebot
REDIS_URL=redis://localhost:6379
PORT=3000
NODE_ENV=development

# Docker Compose Postgres config
POSTGRES_USER=blazebot
POSTGRES_PASSWORD=blazebot
POSTGRES_DB=blazebot
```

- [ ] **Step 3: Copy `.env.example` to `.env`**

Run: `cp .env.example .env`

- [ ] **Step 4: Verify Docker Compose starts**

Run: `docker compose up -d`
Run: `docker compose ps`
Expected: Both `postgres` and `redis` services are "Up" and healthy.

- [ ] **Step 5: Tear down containers**

Run: `docker compose down`

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add Docker Compose for Postgres 16 and Redis 7"
```

---

## Chunk 2: Application Code

### Task 3: Environment validation (`src/env.ts`)

**Files:**
- Create: `src/env.ts`
- Test: `src/env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/env.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("env", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("exports env with DATABASE_URL when valid env vars are set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("NODE_ENV", "development");

    const { env } = await import("./env.js");
    expect(env.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/db");
  });

  it("uses default PORT of 3000 when not set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.PORT).toBe(3000);
  });

  it("uses default NODE_ENV of development when not set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.NODE_ENV).toBe("development");
  });
});
```

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
  },
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- --run`
Expected: FAIL — `./env.js` module not found.

- [ ] **Step 4: Write `src/env.ts`**

```typescript
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url().optional(),
    PORT: z
      .string()
      .default("3000")
      .transform((v) => parseInt(v, 10)),
    NODE_ENV: z
      .enum(["development", "production"])
      .default("development"),
  },
  runtimeEnv: process.env,
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- --run`
Expected: All 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/env.ts src/env.test.ts vitest.config.ts
git commit -m "feat: add type-safe environment validation with @t3-oss/env-core"
```

---

### Task 4: Drizzle ORM config and DB connection (`src/db.ts`, `src/schema.ts`, `drizzle.config.ts`)

**Files:**
- Create: `src/db.ts`
- Create: `src/schema.ts`
- Create: `drizzle.config.ts`

- [ ] **Step 1: Create empty schema barrel file `src/schema.ts`**

```typescript
// Drizzle schema barrel file — add table definitions here in future phases.
```

- [ ] **Step 2: Create `src/db.ts`**

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "./env.js";

const client = postgres(env.DATABASE_URL);

export const db = drizzle({ client });
```

- [ ] **Step 3: Create `drizzle.config.ts`**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 4: Verify TypeScript compilation**

Run: `pnpm build`
Expected: Compiles successfully with output in `dist/`.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/schema.ts drizzle.config.ts
git commit -m "feat: add Drizzle ORM config and database connection module"
```

---

### Task 5: Fastify health check server (`src/index.ts`)

**Files:**
- Create: `src/index.ts`
- Test: `src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("GET /health", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run`
Expected: FAIL — `./index.js` module not found or `buildApp` not exported.

- [ ] **Step 3: Write `src/index.ts`**

```typescript
import Fastify from "fastify";
import { env } from "./env.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
}

async function main() {
  const app = buildApp();

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only start the server when run directly, not when imported in tests
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run`
Expected: All tests PASS (env tests + health check test).

- [ ] **Step 5: Manual smoke test**

Run: `docker compose up -d`
Run: `pnpm dev`
In another terminal: `curl http://localhost:3000/health`
Expected: `{"status":"ok"}`
Stop the dev server with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: add Fastify server with health check endpoint"
```

---

## Chunk 3: Final Verification

### Task 6: End-to-end verification and cleanup

**Files:**
- Modify: None — verification only

- [ ] **Step 1: Clean build**

Run: `rm -rf dist && pnpm build`
Expected: Compiles with no errors.

- [ ] **Step 2: Run all tests**

Run: `pnpm test -- --run`
Expected: All tests pass.

- [ ] **Step 3: Verify Docker Compose + dev server**

Run: `docker compose up -d`
Run: `pnpm dev` (background or separate terminal)
Run: `curl http://localhost:3000/health`
Expected: `{"status":"ok"}`
Tear down: Stop dev server, `docker compose down`.

- [ ] **Step 4: Verify `.env` is gitignored**

Run: `git status`
Expected: `.env` does NOT appear in untracked files.

- [ ] **Step 5: Final commit (if any unstaged changes)**

```bash
git status
# Only commit if there are meaningful changes
```
