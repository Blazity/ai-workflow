# Redis → Neon Postgres Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Upstash Redis entirely (run registry + post-PR gate store) with Neon Postgres via Drizzle ORM, preserving one-click marketplace deployment.

**Architecture:** The adapter interfaces (`RunRegistryAdapter`, `ThreadStore`, `GateStore` public API) stay unchanged — only the implementations behind them move to Postgres. Five Redis hashes collapse into 3 relational tables (`active_runs` merges runs + sandboxes + entry timestamps because `unregister()` already treats them as one lifecycle); the gate store's 3 Lua scripts become single atomic SQL statements (no transactions needed — the Neon HTTP driver has no sessions). Schema migrations run during the Vercel build (`DATABASE_URL` is available there), keeping deploys one-click. Environment isolation comes from Neon branch-per-environment, defended by a build-time guard (`env_marker` table) that fails the build if two `VERCEL_ENV`s share one branch.

**Tech Stack:** `drizzle-orm` (neon-http driver) + `@neondatabase/serverless`, `drizzle-kit` for migrations, `@electric-sql/pglite` (dev-only) for real-SQL unit tests, vitest.

**Decisions locked in during design review (2026-06-10):**
- Real relational schema (future dashboard features), not a KV shim.
- Both stores migrate; zero Redis references remain.
- Migrations run in the Vercel build step (one-click preserved).
- No `env` column — isolation via Neon branching + build-time guard + init-neon skill verification.
- Expired gate rows: filtered by `expires_at > now()` on every read (correctness), physically purged in the existing poll cron (housekeeping).
- Cutover: drain and switch — no data migration. Deploy when the registry is empty; thread-parent / gate-dedupe loss is benign.
- Local dev & e2e hit the Neon development branch via `vercel env pull`.
- Delivery/verification beyond unit tests: handled by the operator (Kacper) at the end.

**Critical semantic invariants (do not lose these in translation):**
1. `register()` must REFRESH the entry timestamp (it's the "authoritative write point" — reconcile's 30s orphan grace period depends on it). Not just `claim()`.
2. `unregister()` deletes run + sandbox + timestamp together but must NOT touch thread parents (they outlive runs).
3. The 30s lock TTL is crash-safety: an expired lock row must be re-acquirable; release only deletes if the token matches.
4. Expired dedupe/current rows behave as ABSENT (Redis TTL semantics): reads filter `expires_at > now()`; `claimRun` on an expired row re-claims it.
5. Slack thread `ts` ("1700000000.000123") stays a string end-to-end — Postgres `text` kills the Upstash JSON-number-coercion hack, but tests must still prove it.
6. GitHub check-run IDs exceed int4 — `check_run_ids` must be `bigint[]`.

**All call sites that change** (everything else goes through the adapter interfaces):
- `apps/worker/src/lib/adapters.ts:22-26` and `src/lib/step-adapters.ts:19-23` — registry instantiation
- `apps/worker/src/routes/webhooks/github.post.ts:56-60` and `src/workflows/post-pr-gate.ts:45-49` — GateStore instantiation
- `apps/worker/src/routes/cron/poll.get.ts` — add expired-row purge
- `apps/worker/env.ts:122-124`, `env.test.ts:28-29`, `e2e/env.ts` — env vars
- `apps/worker/e2e/helpers/redis.ts` + its 14 importers, `scripts/clear-run-registry.ts`
- `SETUP.md`, `README.md`, `.claude/skills/init-upstash/` → `init-neon/`, `.claude/skills/init-env/SKILL.md`

---

### Task 1: Dependencies, Drizzle schema, generated migration

**Files:**
- Modify: `apps/worker/package.json`
- Create: `apps/worker/drizzle.config.ts`
- Create: `apps/worker/src/db/schema.ts`
- Create: `apps/worker/drizzle/0000_*.sql` (generated, committed)

- [ ] **Step 1: Add dependencies**

```bash
cd apps/worker
pnpm add drizzle-orm @neondatabase/serverless
pnpm add -D drizzle-kit @electric-sql/pglite
```

Do NOT remove `@upstash/redis` yet — old code keeps compiling until Task 8.

- [ ] **Step 2: Add db scripts to `apps/worker/package.json`**

In `"scripts"`, add (leave `"build"` alone for now — Task 6 wires it):

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "tsx scripts/db-migrate.ts",
```

- [ ] **Step 3: Create `apps/worker/drizzle.config.ts`**

```ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Only needed by `drizzle-kit migrate`; `generate` works without it.
    url: process.env.DATABASE_URL ?? "",
  },
});
```

- [ ] **Step 4: Create `apps/worker/src/db/schema.ts`**

```ts
import { sql } from "drizzle-orm";
import {
  bigint,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Run registry — replaces the blazebot:active-runs / blazebot:sandboxes /
 * blazebot:entry-timestamps Redis hashes. One row per in-flight ticket;
 * the three hashes shared a lifecycle (unregister cleared all three), so
 * they are one table. createdAt backs reconcile's orphan grace period and
 * is REFRESHED on register(), not just set on claim().
 */
export const activeRuns = pgTable("active_runs", {
  ticketKey: text("ticket_key").primaryKey(),
  runId: text("run_id").notNull(),
  sandboxId: text("sandbox_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Replaces blazebot:failed-tickets — FailedTicketMeta as typed columns. */
export const failedTickets = pgTable("failed_tickets", {
  ticketKey: text("ticket_key").primaryKey(),
  runId: text("run_id").notNull(),
  error: text("error").notNull(),
  /** ISO-8601 string, exactly as FailedTicketMeta.failedAt round-trips today. */
  failedAt: text("failed_at").notNull(),
});

/**
 * Replaces blazebot:thread-parents. Separate table on purpose: thread
 * parents survive across runs for the same ticket (unregister must not
 * clear them). text column = no more Upstash number-coercion of Slack ts.
 */
export const threadParents = pgTable("thread_parents", {
  ticketKey: text("ticket_key").primaryKey(),
  messageId: text("message_id").notNull(),
});

/**
 * Post-PR gate lock — replaces gate:lock:{repo}#{pr} (SET NX EX 30).
 * An expired row counts as released; acquire atomically steals it.
 */
export const gateLocks = pgTable(
  "gate_locks",
  {
    repo: text("repo").notNull(),
    pr: integer("pr").notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.pr] })],
);

/** Replaces gate:dedupe:{repo}#{pr}@{sha} (SET NX EX 14d). */
export const gateDedupe = pgTable(
  "gate_dedupe",
  {
    repo: text("repo").notNull(),
    pr: integer("pr").notNull(),
    headSha: text("head_sha").notNull(),
    runId: text("run_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.pr, t.headSha] })],
);

/**
 * Replaces gate:current:{repo}#{pr} (JSON pointer, EX 14d).
 * bigint[]: GitHub check-run IDs exceed int4 range.
 */
export const gateCurrent = pgTable(
  "gate_current",
  {
    repo: text("repo").notNull(),
    pr: integer("pr").notNull(),
    runId: text("run_id").notNull(),
    headSha: text("head_sha").notNull(),
    checkRunIds: bigint("check_run_ids", { mode: "number" })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.pr] })],
);

/**
 * Environment-isolation guard. Exactly one row (id=1). Claimed at build
 * time by scripts/db-migrate.ts: if a branch is already claimed by a
 * different VERCEL_ENV on the SAME endpoint host, the build fails —
 * preview must never share production's Neon branch. A differing endpoint
 * host means the branch was copied (Neon branches copy data), so the
 * marker is re-claimed instead of failing.
 */
export const envMarker = pgTable("env_marker", {
  id: integer("id").primaryKey(),
  env: text("env").notNull(),
  endpointHost: text("endpoint_host").notNull(),
});
```

- [ ] **Step 5: Generate the migration**

```bash
cd apps/worker && pnpm db:generate
```

Expected: creates `apps/worker/drizzle/0000_<adjective>_<name>.sql` plus `drizzle/meta/`. Open the SQL and verify it contains `CREATE TABLE "active_runs"`, `"failed_tickets"`, `"thread_parents"`, `"gate_locks"`, `"gate_dedupe"`, `"gate_current"`, `"env_marker"`, and that `check_run_ids` is `bigint[]`.

- [ ] **Step 6: Typecheck**

```bash
cd apps/worker && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/package.json apps/worker/drizzle.config.ts apps/worker/src/db/schema.ts apps/worker/drizzle pnpm-lock.yaml
git commit -m "feat(db): add Drizzle schema and migration for Neon run registry + gate store"
```

---

### Task 2: DB client and pglite test harness

**Files:**
- Create: `apps/worker/src/db/client.ts`
- Create: `apps/worker/src/db/test-db.ts`

- [ ] **Step 1: Create `apps/worker/src/db/client.ts`**

```ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { env } from "../../env.js";
import * as schema from "./schema.js";

/**
 * Driver-agnostic database handle. `any` for the query-result HKT so both
 * the neon-http production driver and the pglite test driver are
 * assignable — adapters only use the query-builder surface, which is
 * identical across drivers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

let _db: Db | null = null;

/**
 * Lazily-created singleton. neon() is fetch-based (no sockets, no pools),
 * so a module-level singleton is safe in serverless functions AND inside
 * Workflow DevKit step bundles (same constraint the Upstash REST client
 * satisfied).
 */
export function getDb(): Db {
  if (!_db) {
    _db = drizzle({ client: neon(env.DATABASE_URL), schema });
  }
  return _db;
}
```

Note: `env.DATABASE_URL` doesn't exist yet — Task 5 adds it. To keep this task self-contained and compiling, Task 5 ordering is fine because nothing imports `client.ts` until Task 5 either. If `pnpm typecheck` complains now, add the env var in this task instead (move Task 5 Step 1 here) — both orderings are acceptable.

- [ ] **Step 2: Create `apps/worker/src/db/test-db.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";
import type { Db } from "./client.js";

/**
 * In-memory Postgres for unit tests. Applies the committed drizzle/
 * migration SQL so tests run against the exact production schema —
 * uniqueness conflicts, array ops, and expiry filters behave for real
 * instead of being mocked.
 */
export async function createTestDb(): Promise<Db> {
  const client = new PGlite();
  const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    await client.exec(readFileSync(`${dir}${f}`, "utf8"));
  }
  return drizzle({ client, schema }) as unknown as Db;
}
```

- [ ] **Step 3: Smoke-test the harness** — create a throwaway check inside the next task's test file instead of a separate file (Task 3 Step 1's first test exercises `createTestDb()`). For now just typecheck:

```bash
cd apps/worker && pnpm typecheck
```

Expected: PASS (if `env.DATABASE_URL` errors, see Step 1 note).

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/db/client.ts apps/worker/src/db/test-db.ts
git commit -m "feat(db): add neon-http client and pglite test harness"
```

---

### Task 3: PostgresRunRegistry (TDD)

**Files:**
- Create: `apps/worker/src/adapters/run-registry/postgres.ts`
- Test: `apps/worker/src/adapters/run-registry/postgres.test.ts`

- [ ] **Step 1: Write the failing tests** — `postgres.test.ts`. These port every behavior from `upstash.test.ts` plus the two invariants the old mock-based tests couldn't cover (claim atomicity against real uniqueness; register refreshing the timestamp):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { PostgresRunRegistry } from "./postgres.js";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";

let db: Db;
let registry: PostgresRunRegistry;

beforeEach(async () => {
  db = await createTestDb();
  registry = new PostgresRunRegistry(db);
});

describe("claim", () => {
  it("returns true when the ticket is unclaimed", async () => {
    expect(await registry.claim("PROJ-1", "claiming")).toBe(true);
    expect(await registry.getRunId("PROJ-1")).toBe("claiming");
  });

  it("returns false when the ticket is already claimed", async () => {
    await registry.claim("PROJ-1", "claiming");
    expect(await registry.claim("PROJ-1", "other")).toBe(false);
    expect(await registry.getRunId("PROJ-1")).toBe("claiming");
  });

  it("stamps a creation timestamp", async () => {
    const before = Date.now();
    await registry.claim("PROJ-1", "claiming");
    const ts = await registry.getEntryCreatedAt("PROJ-1");
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("register", () => {
  it("overwrites the runId after a claim", async () => {
    await registry.claim("PROJ-1", "claiming");
    await registry.register("PROJ-1", "run_abc");
    expect(await registry.getRunId("PROJ-1")).toBe("run_abc");
  });

  it("inserts when no claim exists (external seeders)", async () => {
    await registry.register("PROJ-2", "run_xyz");
    expect(await registry.getRunId("PROJ-2")).toBe("run_xyz");
  });

  it("REFRESHES the creation timestamp (authoritative write point — reconcile orphan grace period)", async () => {
    await registry.claim("PROJ-1", "claiming");
    // Backdate the entry past any grace window, as if claimed long ago.
    await db.execute(
      sql`UPDATE active_runs SET created_at = now() - interval '10 minutes' WHERE ticket_key = 'PROJ-1'`,
    );
    const stale = await registry.getEntryCreatedAt("PROJ-1");
    expect(Date.now() - stale!).toBeGreaterThan(9 * 60 * 1000);

    await registry.register("PROJ-1", "run_abc");
    const fresh = await registry.getEntryCreatedAt("PROJ-1");
    expect(Date.now() - fresh!).toBeLessThan(60 * 1000);
  });

  it("does not clobber a registered sandboxId", async () => {
    await registry.claim("PROJ-1", "claiming");
    await registry.registerSandbox("PROJ-1", "sbox_1");
    await registry.register("PROJ-1", "run_abc");
    expect(await registry.getSandboxId("PROJ-1")).toBe("sbox_1");
  });
});

describe("getRunId", () => {
  it("returns null when not registered", async () => {
    expect(await registry.getRunId("PROJ-99")).toBeNull();
  });
});

describe("unregister", () => {
  it("removes run, sandbox, and timestamp together", async () => {
    await registry.claim("PROJ-1", "run_abc");
    await registry.registerSandbox("PROJ-1", "sbox_1");
    await registry.unregister("PROJ-1");
    expect(await registry.getRunId("PROJ-1")).toBeNull();
    expect(await registry.getSandboxId("PROJ-1")).toBeNull();
    expect(await registry.getEntryCreatedAt("PROJ-1")).toBeNull();
  });

  it("does NOT touch thread parents (they outlive runs)", async () => {
    await registry.claim("PROJ-1", "run_abc");
    await registry.setParent("PROJ-1", "1700000000.000123");
    await registry.unregister("PROJ-1");
    expect(await registry.getParent("PROJ-1")).toBe("1700000000.000123");
  });
});

describe("listAll", () => {
  it("returns all ticket -> runId pairs", async () => {
    await registry.claim("PROJ-1", "run_abc");
    await registry.claim("PROJ-2", "run_def");
    const all = await registry.listAll();
    expect(all).toHaveLength(2);
    expect(all).toContainEqual({ ticketKey: "PROJ-1", runId: "run_abc" });
    expect(all).toContainEqual({ ticketKey: "PROJ-2", runId: "run_def" });
  });

  it("returns empty array when none registered", async () => {
    expect(await registry.listAll()).toEqual([]);
  });
});

describe("sandbox", () => {
  it("registerSandbox/getSandboxId round-trips", async () => {
    await registry.claim("PROJ-1", "run_abc");
    await registry.registerSandbox("PROJ-1", "sbox_12345");
    expect(await registry.getSandboxId("PROJ-1")).toBe("sbox_12345");
  });

  it("getSandboxId returns null when never registered", async () => {
    await registry.claim("PROJ-1", "run_abc");
    expect(await registry.getSandboxId("PROJ-1")).toBeNull();
  });
});

describe("failed tickets", () => {
  const meta = {
    runId: "run_abc",
    error: "Failed to move ticket to backlog: 403 Forbidden",
    failedAt: "2026-04-02T12:34:56.000Z",
  };

  it("markFailed/isTicketFailed/listAllFailed round-trips meta exactly", async () => {
    await registry.markFailed("AWT-42", meta);
    expect(await registry.isTicketFailed("AWT-42")).toBe(true);
    expect(await registry.listAllFailed()).toEqual([
      { ticketKey: "AWT-42", meta },
    ]);
  });

  it("markFailed twice updates rather than throwing", async () => {
    await registry.markFailed("AWT-42", meta);
    await registry.markFailed("AWT-42", { ...meta, error: "second" });
    const [entry] = await registry.listAllFailed();
    expect(entry.meta.error).toBe("second");
  });

  it("isTicketFailed returns false / listAllFailed empty when none", async () => {
    expect(await registry.isTicketFailed("AWT-99")).toBe(false);
    expect(await registry.listAllFailed()).toEqual([]);
  });

  it("clearFailedMark removes the marker", async () => {
    await registry.markFailed("AWT-42", meta);
    await registry.clearFailedMark("AWT-42");
    expect(await registry.isTicketFailed("AWT-42")).toBe(false);
  });
});

describe("ThreadStore", () => {
  it("setParent/getParent round-trips a Slack ts as a STRING", async () => {
    await registry.setParent("AWT-42", "1777542341.966359");
    const result = await registry.getParent("AWT-42");
    expect(result).toBe("1777542341.966359");
    expect(typeof result).toBe("string");
  });

  it("setParent overwrites a prior value", async () => {
    await registry.setParent("AWT-42", "111.000");
    await registry.setParent("AWT-42", "222.000");
    expect(await registry.getParent("AWT-42")).toBe("222.000");
  });

  it("getParent returns null when no entry", async () => {
    expect(await registry.getParent("AWT-99")).toBeNull();
  });

  it("clearParent deletes the entry", async () => {
    await registry.setParent("AWT-42", "1700000000.000123");
    await registry.clearParent("AWT-42");
    expect(await registry.getParent("AWT-42")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/worker && pnpm exec vitest run src/adapters/run-registry/postgres.test.ts
```

Expected: FAIL — `Cannot find module './postgres.js'`.

- [ ] **Step 3: Implement `apps/worker/src/adapters/run-registry/postgres.ts`**

```ts
import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  activeRuns,
  failedTickets,
  threadParents,
} from "../../db/schema.js";
import type {
  FailedTicketMeta,
  RunRegistryAdapter,
  ThreadStore,
} from "./types.js";

export class PostgresRunRegistry implements RunRegistryAdapter, ThreadStore {
  constructor(private db: Db) {}

  async claim(ticketKey: string, runId: string): Promise<boolean> {
    // INSERT ... ON CONFLICT DO NOTHING is the HSETNX equivalent: exactly
    // one concurrent claimer gets a row back. created_at defaults to now(),
    // which doubles as the entry timestamp for reconcile's grace period.
    const rows = await this.db
      .insert(activeRuns)
      .values({ ticketKey, runId })
      .onConflictDoNothing({ target: activeRuns.ticketKey })
      .returning({ ticketKey: activeRuns.ticketKey });
    return rows.length > 0;
  }

  async register(ticketKey: string, runId: string): Promise<void> {
    // Refresh created_at: register() is called both on the claim → runId
    // swap and by external seeders, so it's the authoritative write point
    // for the orphan grace period. sandbox_id is intentionally untouched.
    await this.db
      .insert(activeRuns)
      .values({ ticketKey, runId })
      .onConflictDoUpdate({
        target: activeRuns.ticketKey,
        set: { runId, createdAt: sql`now()` },
      });
  }

  async getRunId(ticketKey: string): Promise<string | null> {
    const rows = await this.db
      .select({ runId: activeRuns.runId })
      .from(activeRuns)
      .where(eq(activeRuns.ticketKey, ticketKey));
    return rows[0]?.runId ?? null;
  }

  async unregister(ticketKey: string): Promise<void> {
    // One row holds run, sandbox, and timestamp — deleting it fully
    // detaches the ticket. Thread parents live in their own table and
    // survive (see ThreadStore docs in types.ts).
    await this.db.delete(activeRuns).where(eq(activeRuns.ticketKey, ticketKey));
  }

  async listAll(): Promise<Array<{ ticketKey: string; runId: string }>> {
    return this.db
      .select({ ticketKey: activeRuns.ticketKey, runId: activeRuns.runId })
      .from(activeRuns);
  }

  async registerSandbox(ticketKey: string, sandboxId: string): Promise<void> {
    // Sandboxes are only registered after claim()/register(), so the row
    // exists; a bare UPDATE keeps run_id NOT NULL without an upsert dance.
    await this.db
      .update(activeRuns)
      .set({ sandboxId })
      .where(eq(activeRuns.ticketKey, ticketKey));
  }

  async getSandboxId(ticketKey: string): Promise<string | null> {
    const rows = await this.db
      .select({ sandboxId: activeRuns.sandboxId })
      .from(activeRuns)
      .where(eq(activeRuns.ticketKey, ticketKey));
    return rows[0]?.sandboxId ?? null;
  }

  async getEntryCreatedAt(ticketKey: string): Promise<number | null> {
    const rows = await this.db
      .select({ createdAt: activeRuns.createdAt })
      .from(activeRuns)
      .where(eq(activeRuns.ticketKey, ticketKey));
    return rows[0]?.createdAt?.getTime() ?? null;
  }

  async markFailed(ticketKey: string, meta: FailedTicketMeta): Promise<void> {
    await this.db
      .insert(failedTickets)
      .values({ ticketKey, ...meta })
      .onConflictDoUpdate({
        target: failedTickets.ticketKey,
        set: { runId: meta.runId, error: meta.error, failedAt: meta.failedAt },
      });
  }

  async isTicketFailed(ticketKey: string): Promise<boolean> {
    const rows = await this.db
      .select({ ticketKey: failedTickets.ticketKey })
      .from(failedTickets)
      .where(eq(failedTickets.ticketKey, ticketKey));
    return rows.length > 0;
  }

  async listAllFailed(): Promise<
    Array<{ ticketKey: string; meta: FailedTicketMeta }>
  > {
    const rows = await this.db.select().from(failedTickets);
    return rows.map(({ ticketKey, runId, error, failedAt }) => ({
      ticketKey,
      meta: { runId, error, failedAt },
    }));
  }

  async clearFailedMark(ticketKey: string): Promise<void> {
    await this.db
      .delete(failedTickets)
      .where(eq(failedTickets.ticketKey, ticketKey));
  }

  async getParent(ticketKey: string): Promise<string | null> {
    const rows = await this.db
      .select({ messageId: threadParents.messageId })
      .from(threadParents)
      .where(eq(threadParents.ticketKey, ticketKey));
    return rows[0]?.messageId ?? null;
  }

  async setParent(ticketKey: string, messageId: string): Promise<void> {
    await this.db
      .insert(threadParents)
      .values({ ticketKey, messageId })
      .onConflictDoUpdate({
        target: threadParents.ticketKey,
        set: { messageId },
      });
  }

  async clearParent(ticketKey: string): Promise<void> {
    await this.db
      .delete(threadParents)
      .where(eq(threadParents.ticketKey, ticketKey));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/worker && pnpm exec vitest run src/adapters/run-registry/postgres.test.ts
```

Expected: PASS (all ~20 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/adapters/run-registry/postgres.ts apps/worker/src/adapters/run-registry/postgres.test.ts
git commit -m "feat(registry): Postgres run registry adapter with pglite-backed tests"
```

---

### Task 4: GateStore rewrite (TDD)

**Files:**
- Rewrite: `apps/worker/src/post-pr-gate/gate-store.ts`
- Test: `apps/worker/src/post-pr-gate/gate-store.test.ts` (new)

The public API is unchanged except the constructor: `new GateStore(db)` replaces `new GateStore({ url, token, envPrefix })`. Each Lua script becomes one atomic SQL statement. "Expired" ≡ "absent" everywhere.

- [ ] **Step 1: Write the failing tests** — `gate-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { GateStore } from "./gate-store.js";
import { createTestDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";

let db: Db;
let store: GateStore;

beforeEach(async () => {
  db = await createTestDb();
  store = new GateStore(db);
});

/** Backdate a lock so it reads as TTL-expired. */
async function expireLock(repo: string, pr: number) {
  await db.execute(
    sql`UPDATE gate_locks SET expires_at = now() - interval '1 second' WHERE repo = ${repo} AND pr = ${pr}`,
  );
}

describe("locks", () => {
  it("acquireLock returns a token when free", async () => {
    const token = await store.acquireLock("o/r", 1);
    expect(token).toBeTruthy();
  });

  it("acquireLock returns null while held", async () => {
    await store.acquireLock("o/r", 1);
    expect(await store.acquireLock("o/r", 1)).toBeNull();
  });

  it("acquireLock steals an expired lock (TTL crash-safety)", async () => {
    await store.acquireLock("o/r", 1);
    await expireLock("o/r", 1);
    expect(await store.acquireLock("o/r", 1)).toBeTruthy();
  });

  it("locks are independent per repo+pr", async () => {
    await store.acquireLock("o/r", 1);
    expect(await store.acquireLock("o/r", 2)).toBeTruthy();
    expect(await store.acquireLock("o/other", 1)).toBeTruthy();
  });

  it("releaseLock with the owning token frees the lock", async () => {
    const token = (await store.acquireLock("o/r", 1))!;
    await store.releaseLock("o/r", 1, token);
    expect(await store.acquireLock("o/r", 1)).toBeTruthy();
  });

  it("releaseLock with a stale token is a no-op (compare-and-delete)", async () => {
    await store.acquireLock("o/r", 1);
    await expireLock("o/r", 1);
    const newToken = (await store.acquireLock("o/r", 1))!;
    await store.releaseLock("o/r", 1, "stale-token");
    // still held by newToken
    expect(await store.acquireLock("o/r", 1)).toBeNull();
    await store.releaseLock("o/r", 1, newToken);
    expect(await store.acquireLock("o/r", 1)).toBeTruthy();
  });
});

describe("claimRun (dedupe)", () => {
  it("returns null when we win the claim", async () => {
    expect(await store.claimRun("o/r", 1, "sha1", "run_a")).toBeNull();
  });

  it("returns the existing runId when already claimed", async () => {
    await store.claimRun("o/r", 1, "sha1", "run_a");
    expect(await store.claimRun("o/r", 1, "sha1", "run_b")).toBe("run_a");
  });

  it("different SHA is a fresh claim", async () => {
    await store.claimRun("o/r", 1, "sha1", "run_a");
    expect(await store.claimRun("o/r", 1, "sha2", "run_b")).toBeNull();
  });

  it("an expired claim behaves as absent (re-claimable)", async () => {
    await store.claimRun("o/r", 1, "sha1", "run_a");
    await db.execute(
      sql`UPDATE gate_dedupe SET expires_at = now() - interval '1 second'`,
    );
    expect(await store.claimRun("o/r", 1, "sha1", "run_b")).toBeNull();
    expect(await store.getDedupe("o/r", 1, "sha1")).toBe("run_b");
  });

  it("getDedupe returns null for unknown or expired claims", async () => {
    expect(await store.getDedupe("o/r", 1, "nope")).toBeNull();
    await store.claimRun("o/r", 1, "sha1", "run_a");
    await db.execute(
      sql`UPDATE gate_dedupe SET expires_at = now() - interval '1 second'`,
    );
    expect(await store.getDedupe("o/r", 1, "sha1")).toBeNull();
  });
});

describe("current pointer", () => {
  const current = { runId: "run_a", headSha: "sha1", checkRunIds: [] as number[] };

  it("setCurrent/getCurrent round-trips", async () => {
    await store.setCurrent("o/r", 1, current);
    expect(await store.getCurrent("o/r", 1)).toEqual(current);
  });

  it("getCurrent returns null when absent or expired", async () => {
    expect(await store.getCurrent("o/r", 1)).toBeNull();
    await store.setCurrent("o/r", 1, current);
    await db.execute(
      sql`UPDATE gate_current SET expires_at = now() - interval '1 second'`,
    );
    expect(await store.getCurrent("o/r", 1)).toBeNull();
  });

  it("setCurrent overwrites on force-push (same PR, new SHA)", async () => {
    await store.setCurrent("o/r", 1, current);
    await store.setCurrent("o/r", 1, { runId: "run_b", headSha: "sha2", checkRunIds: [7] });
    expect(await store.getCurrent("o/r", 1)).toEqual({
      runId: "run_b",
      headSha: "sha2",
      checkRunIds: [7],
    });
  });

  it("appendCheckRunIdsForSha appends when SHA matches, accumulating", async () => {
    await store.setCurrent("o/r", 1, current);
    // GitHub check-run IDs exceed int4 — proves bigint[].
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [30000000001])).toBe(true);
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [30000000002, 5])).toBe(true);
    expect((await store.getCurrent("o/r", 1))!.checkRunIds).toEqual([
      30000000001, 30000000002, 5,
    ]);
  });

  it("appendCheckRunIdsForSha returns false on SHA mismatch or missing pointer", async () => {
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [1])).toBe(false);
    await store.setCurrent("o/r", 1, current);
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "superseded", [1])).toBe(false);
    expect((await store.getCurrent("o/r", 1))!.checkRunIds).toEqual([]);
  });

  it("appendCheckRunIdsForSha with empty ids is a no-op true", async () => {
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [])).toBe(true);
  });

  it("updateRunIdIfHeadSha updates only on SHA match, preserving checkRunIds", async () => {
    await store.setCurrent("o/r", 1, current);
    await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [42]);
    expect(await store.updateRunIdIfHeadSha("o/r", 1, "sha1", "run_real")).toBe(true);
    expect(await store.getCurrent("o/r", 1)).toEqual({
      runId: "run_real",
      headSha: "sha1",
      checkRunIds: [42],
    });
    expect(await store.updateRunIdIfHeadSha("o/r", 1, "superseded", "run_x")).toBe(false);
  });

  it("clearCurrent removes the pointer", async () => {
    await store.setCurrent("o/r", 1, current);
    await store.clearCurrent("o/r", 1);
    expect(await store.getCurrent("o/r", 1)).toBeNull();
  });
});

describe("purgeExpired", () => {
  it("deletes only expired rows across all three gate tables", async () => {
    await store.acquireLock("o/r", 1);
    await store.claimRun("o/r", 1, "sha1", "run_a");
    await store.setCurrent("o/r", 1, { runId: "run_a", headSha: "sha1", checkRunIds: [] });
    await store.claimRun("o/r", 2, "sha9", "run_keep");
    // Expire everything for PR 1 only.
    await db.execute(sql`UPDATE gate_locks SET expires_at = now() - interval '1 second' WHERE pr = 1`);
    await db.execute(sql`UPDATE gate_dedupe SET expires_at = now() - interval '1 second' WHERE pr = 1`);
    await db.execute(sql`UPDATE gate_current SET expires_at = now() - interval '1 second' WHERE pr = 1`);

    await store.purgeExpired();

    const locks = await db.execute(sql`SELECT count(*)::int AS n FROM gate_locks`);
    const dedupe = await db.execute(sql`SELECT count(*)::int AS n FROM gate_dedupe`);
    const cur = await db.execute(sql`SELECT count(*)::int AS n FROM gate_current`);
    expect(locks.rows[0].n).toBe(0);
    expect(dedupe.rows[0].n).toBe(1); // run_keep survives
    expect(cur.rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/worker && pnpm exec vitest run src/post-pr-gate/gate-store.test.ts
```

Expected: FAIL (constructor signature mismatch / missing methods).

- [ ] **Step 3: Rewrite `apps/worker/src/post-pr-gate/gate-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gateCurrent, gateDedupe, gateLocks } from "../db/schema.js";

/**
 * Application-level dedupe, force-push tracking, and per-PR locking for
 * post-pr-gate runs — Postgres edition.
 *
 * Three tables (see src/db/schema.ts):
 *   gate_locks   — short-TTL mutex around the webhook critical section.
 *                  Released in `finally`; if the route process dies, the
 *                  expires_at timestamp lets the next acquirer steal it.
 *   gate_dedupe  — one row per {repo, pr, headSha}; INSERT-on-conflict is
 *                  the SET NX equivalent. Absent/expired row means "never
 *                  claimed for this SHA".
 *   gate_current — pointer to the latest run, used to cancel the previous
 *                  run on force-push.
 *
 * TTL semantics: a row past its expires_at is treated as ABSENT by every
 * read (correctness); physical deletion happens via purgeExpired() in the
 * poll cron (housekeeping). Lifetime: 14 days, matching the Redis EX.
 *
 * Each former Lua script is now a single SQL statement, so it stays atomic
 * over the sessionless neon-http driver — no transactions required.
 */

const TTL = sql`now() + interval '14 days'`;
const LOCK_TTL = sql`now() + interval '30 seconds'`;

export interface CurrentGateRun {
  runId: string;
  headSha: string;
  checkRunIds: number[];
}

export class GateStore {
  constructor(private db: Db) {}

  /**
   * Acquire the per-PR lock. Returns a token if acquired, null if busy.
   * Caller MUST call `releaseLock` with the same token in a `finally`.
   * Single statement: insert wins a free lock; the conflict-update with
   * setWhere steals an expired one; otherwise no row returns → busy.
   */
  async acquireLock(repo: string, pr: number): Promise<string | null> {
    const token = randomUUID();
    const rows = await this.db
      .insert(gateLocks)
      .values({ repo, pr, token, expiresAt: LOCK_TTL })
      .onConflictDoUpdate({
        target: [gateLocks.repo, gateLocks.pr],
        set: {
          token: sql`excluded.token`,
          expiresAt: sql`excluded.expires_at`,
        },
        setWhere: sql`${gateLocks.expiresAt} < now()`,
      })
      .returning({ token: gateLocks.token });
    return rows.length > 0 ? token : null;
  }

  /**
   * Release the per-PR lock — only if our token still owns it. A no-op if
   * the lock expired and another holder took over (token-guarded DELETE,
   * the SQL twin of the old compare-and-delete Lua script).
   */
  async releaseLock(repo: string, pr: number, token: string): Promise<void> {
    await this.db
      .delete(gateLocks)
      .where(
        and(
          eq(gateLocks.repo, repo),
          eq(gateLocks.pr, pr),
          eq(gateLocks.token, token),
        ),
      );
  }

  /**
   * Atomically claim a {repo, pr, headSha} as a unique gate run.
   * Returns the existing runId if already claimed, null if we won the race.
   * Designed to be called *inside* `acquireLock`, but the conflict guard is
   * defense-in-depth in case the lock expired mid-critical-section.
   * An expired claim is re-claimable (Redis SET NX EX semantics).
   */
  async claimRun(
    repo: string,
    pr: number,
    headSha: string,
    runId: string,
  ): Promise<string | null> {
    const rows = await this.db
      .insert(gateDedupe)
      .values({ repo, pr, headSha, runId, expiresAt: TTL })
      .onConflictDoUpdate({
        target: [gateDedupe.repo, gateDedupe.pr, gateDedupe.headSha],
        set: {
          runId: sql`excluded.run_id`,
          expiresAt: sql`excluded.expires_at`,
        },
        setWhere: sql`${gateDedupe.expiresAt} < now()`,
      })
      .returning({ runId: gateDedupe.runId });
    if (rows.length > 0) return null; // inserted fresh or reclaimed expired
    return this.getDedupe(repo, pr, headSha);
  }

  async getDedupe(
    repo: string,
    pr: number,
    headSha: string,
  ): Promise<string | null> {
    const rows = await this.db
      .select({ runId: gateDedupe.runId })
      .from(gateDedupe)
      .where(
        and(
          eq(gateDedupe.repo, repo),
          eq(gateDedupe.pr, pr),
          eq(gateDedupe.headSha, headSha),
          sql`${gateDedupe.expiresAt} > now()`,
        ),
      );
    return rows[0]?.runId ?? null;
  }

  async getCurrent(repo: string, pr: number): Promise<CurrentGateRun | null> {
    const rows = await this.db
      .select({
        runId: gateCurrent.runId,
        headSha: gateCurrent.headSha,
        checkRunIds: gateCurrent.checkRunIds,
      })
      .from(gateCurrent)
      .where(
        and(
          eq(gateCurrent.repo, repo),
          eq(gateCurrent.pr, pr),
          sql`${gateCurrent.expiresAt} > now()`,
        ),
      );
    return rows[0] ?? null;
  }

  async setCurrent(
    repo: string,
    pr: number,
    value: CurrentGateRun,
  ): Promise<void> {
    await this.db
      .insert(gateCurrent)
      .values({ repo, pr, ...value, expiresAt: TTL })
      .onConflictDoUpdate({
        target: [gateCurrent.repo, gateCurrent.pr],
        set: {
          runId: value.runId,
          headSha: value.headSha,
          checkRunIds: value.checkRunIds,
          expiresAt: TTL,
        },
      });
  }

  /**
   * Atomically append check-run IDs to the current pointer, but only if the
   * pointer's headSha still matches `expectedHeadSha`. Returns true if the
   * append happened, false if the row is missing, expired, or superseded by
   * a force-push. Single conditional UPDATE = the old SHA-guarded Lua
   * append; not touching expires_at = KEEPTTL.
   */
  async appendCheckRunIdsForSha(
    repo: string,
    pr: number,
    expectedHeadSha: string,
    ids: number[],
  ): Promise<boolean> {
    if (ids.length === 0) return true;
    // IDs are validated integers; inlined as an array literal because the
    // append expression needs a typed bigint[] on the right-hand side.
    if (!ids.every((id) => Number.isSafeInteger(id))) {
      throw new Error(`non-integer check-run ids: ${ids.join(",")}`);
    }
    const literal = sql.raw(`'{${ids.join(",")}}'::bigint[]`);
    const rows = await this.db
      .update(gateCurrent)
      .set({ checkRunIds: sql`${gateCurrent.checkRunIds} || ${literal}` })
      .where(
        and(
          eq(gateCurrent.repo, repo),
          eq(gateCurrent.pr, pr),
          eq(gateCurrent.headSha, expectedHeadSha),
          sql`${gateCurrent.expiresAt} > now()`,
        ),
      )
      .returning({ pr: gateCurrent.pr });
    return rows.length > 0;
  }

  /**
   * Atomically set the `runId` field of the current pointer, but only if
   * the pointer's headSha still matches `expectedHeadSha`. Returns true if
   * the update happened, false if the row is missing or superseded.
   *
   * Used by the webhook to fill in the real runId AFTER `start()` returns,
   * without stomping `checkRunIds` that the workflow may have already
   * appended — a column-targeted UPDATE only touches run_id, so that
   * property now holds structurally.
   */
  async updateRunIdIfHeadSha(
    repo: string,
    pr: number,
    expectedHeadSha: string,
    runId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(gateCurrent)
      .set({ runId })
      .where(
        and(
          eq(gateCurrent.repo, repo),
          eq(gateCurrent.pr, pr),
          eq(gateCurrent.headSha, expectedHeadSha),
          sql`${gateCurrent.expiresAt} > now()`,
        ),
      )
      .returning({ pr: gateCurrent.pr });
    return rows.length > 0;
  }

  async clearCurrent(repo: string, pr: number): Promise<void> {
    await this.db
      .delete(gateCurrent)
      .where(and(eq(gateCurrent.repo, repo), eq(gateCurrent.pr, pr)));
  }

  /**
   * Physically delete expired rows. Reads already treat them as absent;
   * this is housekeeping so tables don't grow forever. Called from the
   * poll cron (src/routes/cron/poll.get.ts), best-effort.
   */
  async purgeExpired(): Promise<void> {
    await this.db.delete(gateLocks).where(sql`${gateLocks.expiresAt} < now()`);
    await this.db
      .delete(gateDedupe)
      .where(sql`${gateDedupe.expiresAt} < now()`);
    await this.db
      .delete(gateCurrent)
      .where(sql`${gateCurrent.expiresAt} < now()`);
  }
}
```

Note for the implementer: drizzle's `.values()` accepts `sql` expressions for the timestamp columns; if the installed drizzle version's types reject `SQL` for a `timestamp` column in `values()`, type the column value as `sql\`now() + interval '30 seconds'\`` via `.$type<Date>()` on the schema column or compute `new Date(Date.now() + ms)` in JS instead — behavior is equivalent (clock source shifts from DB to app; tests don't care).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/worker && pnpm exec vitest run src/post-pr-gate/gate-store.test.ts
```

Expected: PASS. Note: `github.post.ts` / `post-pr-gate.ts` now FAIL typecheck (old constructor args) — fixed next task; don't run `pnpm typecheck` as a gate here.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/post-pr-gate/gate-store.ts apps/worker/src/post-pr-gate/gate-store.test.ts
git commit -m "feat(gate): rewrite gate store on Postgres, Lua scripts to atomic SQL"
```

---

### Task 5: Wire-up — env, adapters, webhook, workflow, poll purge

**Files:**
- Modify: `apps/worker/env.ts:122-124`
- Modify: `apps/worker/env.test.ts:28-29`
- Modify: `apps/worker/src/lib/adapters.ts`
- Modify: `apps/worker/src/lib/step-adapters.ts`
- Modify: `apps/worker/src/routes/webhooks/github.post.ts:56-60`
- Modify: `apps/worker/src/workflows/post-pr-gate.ts:45-49`
- Modify: `apps/worker/src/routes/cron/poll.get.ts`

- [ ] **Step 1: Swap env vars in `apps/worker/env.ts`** — replace lines 122-124:

```ts
    // Redis (run registry)
    AI_WORKFLOW_KV_REST_API_URL: z.string().url(),
    AI_WORKFLOW_KV_REST_API_TOKEN: z.string().min(1),
```

with:

```ts
    // Neon Postgres (run registry + post-PR gate store) — auto-injected by
    // the Neon Vercel Marketplace integration, one branch per environment.
    DATABASE_URL: z.string().url(),
```

- [ ] **Step 2: Update `apps/worker/env.test.ts:28-29`** — replace:

```ts
    AI_WORKFLOW_KV_REST_API_URL: "https://fake.upstash.io",
    AI_WORKFLOW_KV_REST_API_TOKEN: "fake-token",
```

with:

```ts
    DATABASE_URL: "postgresql://user:pass@ep-fake.neon.tech/neondb",
```

- [ ] **Step 3: Update `apps/worker/src/lib/adapters.ts`** — replace the import of `UpstashRunRegistry` and the instantiation:

```ts
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
import { getDb } from "../db/client.js";
```

and in `createAdapters()`:

```ts
  const runRegistry = new PostgresRunRegistry(getDb());
```

(The `url`/`token` args disappear; everything else in the file is unchanged.)

- [ ] **Step 4: Same change in `apps/worker/src/lib/step-adapters.ts`** — identical import swap and `new PostgresRunRegistry(getDb())` in `createStepAdapters()`.

- [ ] **Step 5: Update GateStore call sites.** In `apps/worker/src/routes/webhooks/github.post.ts:56-60` and `apps/worker/src/workflows/post-pr-gate.ts:45-49`, replace:

```ts
  const gateStore = new GateStore({
    url: env.AI_WORKFLOW_KV_REST_API_URL,
    token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
    envPrefix: env.VERCEL_ENV ?? "development",
  });
```

with:

```ts
  const gateStore = new GateStore(getDb());
```

adding `import { getDb } from "../db/client.js";` (webhook) / `import { getDb } from "../db/client.js";` with the correct relative path from `src/workflows/` (`"../db/client.js"`). If `env` becomes unused in either file, remove the import only if nothing else uses it (post-pr-gate.ts uses `env` elsewhere — check before removing).

- [ ] **Step 6: Add the purge to `apps/worker/src/routes/cron/poll.get.ts`.** After the `reconcileRuns(...)` call and before the `return`, add:

```ts
  // Housekeeping: physically drop expired gate rows (reads already treat
  // them as absent). Best-effort — a failed purge must not fail the poll.
  await new GateStore(getDb())
    .purgeExpired()
    .catch((err) => logger.warn({ error: err }, "poll_gate_purge_failed"));
```

with imports:

```ts
import { GateStore } from "../../post-pr-gate/gate-store.js";
import { getDb } from "../../db/client.js";
```

- [ ] **Step 7: Verify**

```bash
cd apps/worker && pnpm typecheck && pnpm test
```

Expected: typecheck PASS; all unit tests PASS (env.test.ts, postgres.test.ts, gate-store.test.ts, and the pre-existing suites). `upstash.test.ts` still passes — it's removed in Task 8.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/env.ts apps/worker/env.test.ts apps/worker/src/lib/adapters.ts apps/worker/src/lib/step-adapters.ts apps/worker/src/routes/webhooks/github.post.ts apps/worker/src/workflows/post-pr-gate.ts apps/worker/src/routes/cron/poll.get.ts
git commit -m "feat(db): wire Postgres registry and gate store into adapters, webhook, workflow, poll"
```

---

### Task 6: Build-time migration + environment-isolation guard

**Files:**
- Create: `apps/worker/scripts/db-migrate.ts`
- Modify: `apps/worker/package.json` (build script)

- [ ] **Step 1: Create `apps/worker/scripts/db-migrate.ts`**

```ts
/**
 * Build-time migration runner + environment-isolation guard.
 *
 * Runs as part of `pnpm build` on Vercel, where the Neon Marketplace
 * integration injects DATABASE_URL per environment (branch-per-env).
 * Keeps deployment one-click: every deploy is schema-self-healing.
 *
 * Guard: the env_marker row pins this database branch to one VERCEL_ENV.
 * - Same endpoint host, different env  → FAIL the build. Preview and
 *   production are sharing a branch; the run registries would collide
 *   (preview claiming production tickets, deleting its Slack threads).
 * - Different endpoint host             → the branch was copied (Neon
 *   branches copy data, marker included) — re-claim it for this env.
 *
 * Locally (no DATABASE_URL) this is a warn-and-skip no-op so `pnpm build`
 * still works without a database.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[db-migrate] DATABASE_URL not set — skipping migrations.");
  process.exit(0);
}

execSync("pnpm exec drizzle-kit migrate", { stdio: "inherit" });

const sql = neon(url);
const vercelEnv = process.env.VERCEL_ENV ?? "development";
const host = new URL(url).host;

await sql`
  INSERT INTO env_marker (id, env, endpoint_host)
  VALUES (1, ${vercelEnv}, ${host})
  ON CONFLICT (id) DO NOTHING
`;
const rows = await sql`SELECT env, endpoint_host FROM env_marker WHERE id = 1`;
const marker = rows[0] as { env: string; endpoint_host: string };

if (marker.endpoint_host !== host) {
  console.warn(
    `[db-migrate] branch copied from '${marker.env}' (${marker.endpoint_host}) — re-claiming for '${vercelEnv}'.`,
  );
  await sql`UPDATE env_marker SET env = ${vercelEnv}, endpoint_host = ${host} WHERE id = 1`;
} else if (marker.env !== vercelEnv) {
  console.error(
    `[db-migrate] FATAL: this Neon branch is already claimed by VERCEL_ENV='${marker.env}', ` +
      `but this build is VERCEL_ENV='${vercelEnv}'. Environments must not share a branch — ` +
      `enable branch-per-environment in the Neon Vercel integration (see SETUP.md §4).`,
  );
  process.exit(1);
} else {
  console.log(`[db-migrate] OK — branch claimed by '${vercelEnv}'.`);
}
```

- [ ] **Step 2: Wire into the build.** In `apps/worker/package.json`, change:

```json
"build": "pnpm validate:pre-sandbox && rm -rf .nitro/workflow && NODE_OPTIONS=--max-old-space-size=8192 nitro build",
```

to:

```json
"build": "pnpm validate:pre-sandbox && pnpm db:migrate && rm -rf .nitro/workflow && NODE_OPTIONS=--max-old-space-size=8192 nitro build",
```

- [ ] **Step 3: Verify the no-DB path locally**

```bash
cd apps/worker && env -u DATABASE_URL pnpm db:migrate
```

Expected: `[db-migrate] DATABASE_URL not set — skipping migrations.` and exit 0.

- [ ] **Step 4: Verify against the Neon development branch.** Note: `drizzle-kit`/`tsx` do not auto-load `.env.local`, and the repo's scripts load `.env` via `dotenv/config` — so pull explicitly to `.env`:

```bash
cd apps/worker && vercel env pull .env
```

Then:

```bash
cd apps/worker && pnpm db:migrate
```

Expected: drizzle-kit applies `0000_*.sql`, then `[db-migrate] OK — branch claimed by 'development'.` Re-running is idempotent (no pending migrations, same marker).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/scripts/db-migrate.ts apps/worker/package.json
git commit -m "feat(build): run migrations and env-isolation guard during Vercel build"
```

---

### Task 7: E2E helpers, e2e env, and maintenance script

**Files:**
- Create: `apps/worker/e2e/helpers/registry.ts` (replaces `e2e/helpers/redis.ts`)
- Delete: `apps/worker/e2e/helpers/redis.ts`
- Modify: 14 importers in `apps/worker/e2e/tier2/*.test.ts` (list below)
- Modify: `apps/worker/e2e/env.ts`
- Rewrite: `apps/worker/scripts/clear-run-registry.ts`

- [ ] **Step 1: Create `apps/worker/e2e/helpers/registry.ts`** — same exported names/signatures as the old redis helper, raw `neon` client (e2e doesn't need drizzle):

```ts
import { neon } from "@neondatabase/serverless";
import { e2eEnv } from "../env.js";

/**
 * Direct DB access for e2e seeding/cleanup. Must point at the SAME Neon
 * branch as the deployment under test (vercel env pull for the matching
 * environment).
 */
const sql = neon(e2eEnv.DATABASE_URL);

export async function getRunId(ticketKey: string): Promise<string | null> {
  const rows = await sql`SELECT run_id FROM active_runs WHERE ticket_key = ${ticketKey}`;
  return (rows[0]?.run_id as string | undefined) ?? null;
}

export async function listAll(): Promise<
  Array<{ ticketKey: string; runId: string }>
> {
  const rows = await sql`SELECT ticket_key, run_id FROM active_runs`;
  return rows.map((r) => ({
    ticketKey: r.ticket_key as string,
    runId: r.run_id as string,
  }));
}

export async function setEntry(
  ticketKey: string,
  runId: string,
  opts?: { ageMs?: number },
): Promise<void> {
  // Mirror the production adapter: created_at backs reconcile's orphan
  // grace window (src/lib/reconcile.ts:ORPHAN_GRACE_MS). Callers
  // exercising the orphan-cancel path (US-15) pass `ageMs` to backdate
  // past the grace window so reconcile acts on the first tick.
  const ageMs = opts?.ageMs ?? 0;
  await sql`
    INSERT INTO active_runs (ticket_key, run_id, created_at)
    VALUES (${ticketKey}, ${runId}, now() - make_interval(secs => ${ageMs / 1000}))
    ON CONFLICT (ticket_key) DO UPDATE
      SET run_id = excluded.run_id, created_at = excluded.created_at
  `;
}

export async function cleanup(ticketKey: string): Promise<void> {
  await sql`DELETE FROM active_runs WHERE ticket_key = ${ticketKey}`.catch(
    () => {},
  );
}

export interface FailedTicketMeta {
  runId: string;
  error: string;
  failedAt: string;
}

export async function markFailed(
  ticketKey: string,
  meta: FailedTicketMeta,
): Promise<void> {
  await sql`
    INSERT INTO failed_tickets (ticket_key, run_id, error, failed_at)
    VALUES (${ticketKey}, ${meta.runId}, ${meta.error}, ${meta.failedAt})
    ON CONFLICT (ticket_key) DO UPDATE
      SET run_id = excluded.run_id, error = excluded.error, failed_at = excluded.failed_at
  `;
}

export async function isTicketFailed(ticketKey: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM failed_tickets WHERE ticket_key = ${ticketKey}`;
  return rows.length > 0;
}

export async function cleanupFailed(ticketKey: string): Promise<void> {
  await sql`DELETE FROM failed_tickets WHERE ticket_key = ${ticketKey}`.catch(
    () => {},
  );
}
```

- [ ] **Step 2: Update the 14 importers.** Files (import line numbers from the audit): `us01-clear-ticket-pr.test.ts:16`, `us03-review-fix-cycle.test.ts:20`, `us04-merge-conflict-rebase.test.ts:19`, `us05-unclear-ticket-clarification.test.ts:10`, `us06-clarification-answered.test.ts:17`, `us07-agent-failure-backlog.test.ts:9`, `us08-previously-failed-skip.test.ts:16`, `us09-failed-marker-cleared.test.ts:14`, `us10-duplicate-dispatch-prevented.test.ts:13`, `us11-capacity-limit-respected.test.ts:13`, `us12-ticket-moved-out-during-dispatch.test.ts:9`, `us13-webhook-immediate-dispatch.test.ts:9`, `us14-stale-claim-cleanup.test.ts:12`, `us15-orphaned-run-cancelled.test.ts:12`.

```bash
cd apps/worker
grep -rl 'helpers/redis' e2e/tier2 | xargs sed -i '' 's|helpers/redis\.js|helpers/registry.js|g'
git rm e2e/helpers/redis.ts
grep -rn 'helpers/redis' e2e   # expected: no output
```

- [ ] **Step 3: Update `apps/worker/e2e/env.ts`** — replace:

```ts
  AI_WORKFLOW_KV_REST_API_URL: z.string().url(),
  AI_WORKFLOW_KV_REST_API_TOKEN: z.string().min(1),
```

with:

```ts
  /**
   * Neon Postgres connection for the SAME branch the deployment under test
   * uses (registry seeding/cleanup). Pull with `vercel env pull` for the
   * matching environment.
   */
  DATABASE_URL: z.string().url(),
```

(Also delete the now-stale `VERCEL_ENV` doc-comment line "Must match the deployed app's VERCEL_ENV" ONLY if nothing else in e2e uses `e2eEnv.VERCEL_ENV` — `grep -rn "e2eEnv.VERCEL_ENV" e2e/` first; if other helpers use it, leave it.)

- [ ] **Step 4: Rewrite `apps/worker/scripts/clear-run-registry.ts`**

```ts
/**
 * Clear run-registry entries in Neon Postgres.
 *
 *   pnpm exec tsx scripts/clear-run-registry.ts            # show state, no writes
 *   pnpm exec tsx scripts/clear-run-registry.ts AWT-42     # clear one ticket
 *   pnpm exec tsx scripts/clear-run-registry.ts --all      # clear every ticket
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}
const sql = neon(url);

const tables = {
  active: "active_runs",
  failed: "failed_tickets",
  threads: "thread_parents",
} as const;

async function dump() {
  for (const [label, table] of Object.entries(tables)) {
    const rows = await sql.query(`SELECT * FROM ${table}`);
    console.log(`\n[${label}] ${table}`);
    if (rows.length === 0) console.log("  (empty)");
    else for (const r of rows) console.log(`  ${JSON.stringify(r)}`);
  }
}

async function clearTicket(t: string) {
  for (const [label, table] of Object.entries(tables)) {
    const rows = await sql.query(
      `DELETE FROM ${table} WHERE ticket_key = $1 RETURNING ticket_key`,
      [t],
    );
    console.log(`  delete ${label} ${t} -> ${rows.length}`);
  }
}

async function clearAll() {
  for (const [label, table] of Object.entries(tables)) {
    const rows = await sql.query(`DELETE FROM ${table} RETURNING ticket_key`);
    console.log(`  delete all ${label} -> ${rows.length}`);
  }
}

const args = process.argv.slice(2);
(async () => {
  if (args.length === 0) {
    console.log("dumping current state (no writes)");
    await dump();
    return;
  }
  if (args[0] === "--all") {
    if (args.length !== 2 || args[1] !== "--yes") {
      console.error(
        "refusing to clear ALL run-registry tables without confirmation.\n" +
          "  re-run with: pnpm exec tsx scripts/clear-run-registry.ts --all --yes",
      );
      process.exit(1);
    }
    console.log("clearing ALL run-registry tables");
    await clearAll();
    return;
  }
  if (args.length !== 1) {
    console.error(`unexpected extra args: ${args.slice(1).join(" ")}`);
    process.exit(1);
  }
  console.log(`clearing ticket ${args[0]}`);
  await clearTicket(args[0]);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Note: `thread_parents` is now included in `--all`/single-ticket clears (the old script couldn't touch it). That matches the script's "reset everything for a ticket" intent; the Slack thread simply restarts.

- [ ] **Step 5: Verify**

```bash
cd apps/worker && pnpm typecheck
pnpm exec tsx scripts/clear-run-registry.ts        # against dev branch .env — dumps (likely empty) tables
```

Expected: typecheck PASS; script prints the three tables.

- [ ] **Step 6: Commit**

```bash
git add -A apps/worker/e2e apps/worker/scripts/clear-run-registry.ts
git commit -m "feat(e2e): port registry helpers and clear script to Postgres"
```

---

### Task 8: Remove Upstash — code, dependency, last references

**Files:**
- Delete: `apps/worker/src/adapters/run-registry/upstash.ts`
- Delete: `apps/worker/src/adapters/run-registry/upstash.test.ts`
- Modify: `apps/worker/package.json` (drop `@upstash/redis`)

- [ ] **Step 1: Delete the adapter and its tests; drop the dependency**

```bash
cd apps/worker
git rm src/adapters/run-registry/upstash.ts src/adapters/run-registry/upstash.test.ts
pnpm remove @upstash/redis
```

- [ ] **Step 2: Verify zero Redis references remain in code**

```bash
cd /Users/kacper/Desktop/blazity/ai-workflow
grep -rn -i "upstash\|AI_WORKFLOW_KV" apps --include="*.ts" --include="*.json" | grep -v node_modules
```

Expected: no output. (Docs/skills still match — next task.)

- [ ] **Step 3: Full verification**

```bash
cd apps/worker && pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A apps/worker pnpm-lock.yaml
git commit -m "chore: remove @upstash/redis and the Upstash run-registry adapter"
```

---

### Task 9: Docs and operator skills

**Files:**
- Modify: `SETUP.md` (§4 lines 201-213, env table line 251, troubleshooting lines 482+488, skills list line 504, toc line 12, prerequisites line 43)
- Modify: `README.md` (lines 111, 136, 144, 225)
- Create: `.claude/skills/init-neon/SKILL.md`
- Delete: `.claude/skills/init-upstash/`
- Modify: `.claude/skills/init-env/SKILL.md` (description line 3, step list line 39, step 6 lines 156-164, summary table line 354, diagram line 380)

- [ ] **Step 1: Rewrite SETUP.md §4** ("Install the Upstash marketplace integration" → "Install the Neon Postgres marketplace integration"):

```markdown
## 4. Install the Neon Postgres marketplace integration

ai-workflow uses Neon Postgres as its run registry and post-PR-gate store
(atomic claim/release for concurrent runs, dedupe, locking). Tables are
created automatically — migrations run during every deploy's build step.

1. Open https://vercel.com/marketplace/neon and click **Install**.
2. Connect it to the ai-workflow Vercel project.
3. **Critical:** enable a **separate branch per environment** (development /
   preview / production) when configuring the integration. Each environment's
   `DATABASE_URL` must point at its own Neon branch. The build fails with an
   `env_marker` error if two environments share one branch — that guard
   protects the production run registry from preview deployments.

Verify:

```bash
vercel env ls | grep DATABASE_URL
```

You should see `DATABASE_URL` present for each environment, with different
values.
```

Also update: toc line 12, prerequisites line 43 (`**Neon Postgres** — installed via Vercel Marketplace in step 4.`), env-table line 251 (`| \`DATABASE_URL\` | Auto-injected by Neon integration |`), troubleshooting line 482 (`DATABASE_URL undefined` → reinstall the Neon integration / check it's connected to this project), line 488 ("flush the registry key in Upstash" → "run `pnpm exec tsx scripts/clear-run-registry.ts <ticket>`"), skills list line 504 (Upstash → Neon).

- [ ] **Step 2: Update README.md** — line 111 (Run Registry row → `[Neon Postgres](https://neon.tech) (via Vercel Marketplace integration)`), line 136 ("in Redis" → "in Postgres"), line 144 ("Redis run registry" → "Postgres run registry"), line 225 ("atomic claim pattern via Upstash Redis" → "atomic claim pattern via Postgres (`INSERT … ON CONFLICT DO NOTHING`)").

- [ ] **Step 3: Create `.claude/skills/init-neon/SKILL.md`** — model the structure on the deleted `.claude/skills/init-upstash/SKILL.md` (read it before deleting; ~70 lines: frontmatter, when-to-use, state detection, runbook, verification). Required content:

```markdown
---
name: init-neon
description: Configure the Neon Postgres database for Blazebot (run registry + post-PR gate store) via the Vercel Marketplace. Verifies DATABASE_URL is injected per environment, that environments do NOT share a branch, and that migrations apply. Use for "set up neon", "set up postgres", "configure database", "fix run registry", "env_marker error".
---

# Init Neon Postgres

## State detection
1. `vercel env ls | grep DATABASE_URL` — if present for all three environments, skip install and go to verification.
2. If missing: walk the user through https://vercel.com/marketplace/neon →
   Install → connect to this project → **enable branch-per-environment**.
   CLI alternative: `vercel integration add neon`.

## Verification (all must pass)
1. `vercel env ls` shows `DATABASE_URL` for development, preview, and production.
2. Branch isolation: pull each environment's value and confirm the hosts
   differ (`vercel env pull --environment=production .env.prod` etc., compare
   the `ep-…` endpoint hosts). Identical hosts across environments = the
   build's env_marker guard will fail — fix the integration's branch settings.
3. Migrations: `cd apps/worker && pnpm db:migrate` against the development
   branch (`vercel env pull`) — expect "OK — branch claimed by 'development'".

## Troubleshooting
- Build fails with `env_marker ... already claimed by VERCEL_ENV='production'`:
  two environments share one Neon branch. Reconfigure the integration for
  branch-per-environment, redeploy.
- `DATABASE_URL undefined` at build: integration not connected to this
  project, or env var scoped to the wrong environments.
```

- [ ] **Step 4: Delete init-upstash and update init-env**

```bash
git rm -r .claude/skills/init-upstash
```

In `.claude/skills/init-env/SKILL.md`: line 3 description ("Upstash" → "Neon"), line 39 (`6.  init-neon → Marketplace install runbook`), lines 156-164 (Step 6 invokes `init-neon`; prompt text "Ready for Step 6: Neon Postgres?" / "Neon installed. Ready for Step 7: cron secret?"), line 354 (summary table row: `Neon  DATABASE_URL per environment  via Marketplace`), line 380 (diagram: `init-upstash` → `init-neon`).

- [ ] **Step 5: Verify no stale references**

```bash
cd /Users/kacper/Desktop/blazity/ai-workflow
grep -rn -i "upstash" README.md SETUP.md .claude/skills docs/superpowers/plans/2026-06-10-redis-to-neon-postgres.md --include="*.md" -l
```

Expected: only this plan file (historical context is fine).

- [ ] **Step 6: Commit**

```bash
git add SETUP.md README.md .claude/skills
git commit -m "docs: replace Upstash setup with Neon Postgres (SETUP.md, README, init-neon skill)"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full suite from the repo root**

```bash
cd /Users/kacper/Desktop/blazity/ai-workflow
pnpm typecheck && pnpm test
```

Expected: PASS across worker (and dashboard, unchanged).

- [ ] **Step 2: Production-shaped build** (with dev `DATABASE_URL` in `apps/worker/.env` from `vercel env pull`):

```bash
cd apps/worker && pnpm build
```

Expected: `validate:pre-sandbox` passes → `[db-migrate] OK — branch claimed by 'development'` → nitro build completes.

- [ ] **Step 3: Repo-wide sanity grep**

```bash
grep -rn -i "upstash\|AI_WORKFLOW_KV" apps .claude/skills SETUP.md README.md --include="*.ts" --include="*.json" --include="*.md" | grep -v node_modules | grep -v "plans/2026-06-10"
```

Expected: no output.

- [ ] **Step 4: Commit any stragglers, then hand off**

Remaining verification is operator-owned (per design review): deploy to a preview environment when the registry is drained (`/ai-workflow status` or dashboard shows no live runs), run the e2e suite against the Neon dev branch (`pnpm test:e2e` — note e2e `.env` needs `DATABASE_URL` instead of the two `AI_WORKFLOW_KV_*` vars), and live-smoke one ticket plus one gate PR. Cutover note: existing Slack threads restart (thread parents are not migrated) and old PRs may re-run the gate once (dedupe history not migrated) — both accepted in the design review.

---

## Self-review notes

- **Spec coverage:** every design-review decision maps to a task — schema (T1), drizzle+neon (T1-2), build-time migrate + one-click (T6), no-env-column + branch guard (T1 `env_marker`, T6 guard, T9 init-neon verification), cron purge (T4 `purgeExpired` + T5 poll wiring), TTL-as-correctness (T4 `expires_at > now()` on every read + expired-lock steal test), drain cutover (T10 handoff note), dev/e2e on Neon dev branch (T7), full Upstash removal incl. tooling (T8-9).
- **Deviation flagged:** the design review said "init-env verification + startup guard"; this plan implements the guard at **build time** (db-migrate.ts) instead of runtime. Rationale: on Vercel, env-var changes only take effect via redeploy, so every config change passes through a build — the guard runs at exactly the right moments, fails loudly before traffic, and adds zero hot-path latency. The init-neon skill check covers setup time.
- **Known judgment calls for the implementer:** (1) drizzle `values()` with `sql` timestamps — fallback documented in T4 Step 3 note; (2) `registerSandbox` assumes the active-run row exists (true today: sandboxes register only after claim) — the T3 test suite pins current behavior; (3) `clear-run-registry --all` now also clears thread parents (improvement, noted in T7).
