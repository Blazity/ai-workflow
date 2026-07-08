# UI-Configurable Pre-PR Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the pre-PR check gate's configuration from the `PRE_PR_CHECKS` env var into Postgres with a versioned dashboard editor (spec: `docs/superpowers/specs/2026-07-08-pre-pr-checks-ui-design.md`).

**Architecture:** An append-only `pre_pr_check_config_versions` table is the single source of truth (current = highest version; rollback = append with `restored_from_version`). The worker exposes `GET/PUT /api/v1/pre-pr-checks`, `POST /api/v1/pre-pr-checks/restore`, and `GET /api/v1/repositories`; the workflow step reads the latest version from the DB. The dashboard gets a "Pre-PR checks" cockpit screen (structured editor + repo picker + history panel) behind thin BFF proxy routes. The env var is retired.

**Tech Stack:** Nitro/h3 routes, drizzle + Neon Postgres (pglite in tests), zod, Vitest (worker), Next 15 App Router + Tailwind v4 (dashboard), `node:test` (dashboard BFF handlers).

## Global Constraints

- **Branch off `origin/dev`** — the pre-PR checks feature (PR #113) exists only on `dev`. Create the working branch with `git fetch origin && git checkout -b feat/pre-pr-checks-ui origin/dev` (inside a worktree if using one).
- pnpm monorepo. Worker tests: `pnpm --filter worker exec vitest run <file>`. Worker typecheck: `pnpm --filter worker typecheck`. Dashboard typecheck: `npx tsc -p apps/dashboard/tsconfig.json --noEmit` (dashboard has no typecheck script). Dashboard handler tests: `node --test <file>` from `apps/dashboard/` (Node ≥ 23.6 strips types natively; on older Node add `--experimental-strip-types`).
- Match repo style: worker routes are `defineEventHandler` + `try { … } catch (error) { toHttpError(error); }`; domain logic lives in testable modules; dashboard mutations are plain `fetch` to same-origin BFF routes; no new dependencies.
- Roles: `owner`/`admin` edit, `member` read-only. Server enforces regardless of UI state.
- `docs/SPEC.md` edits in Task 7 apply **only if** PR #114 (docs refresh) has merged into the branch's history — check with `grep -q "Pre-PR Checks (optional gate)" docs/SPEC.md`. If absent, skip the SPEC edits and say so in the task report.

---

### Task 1: Schema, migration, role helper, and store

**Files:**
- Modify: `apps/worker/src/db/schema.ts` (add table + `serial` import)
- Modify: `apps/worker/src/lib/auth/roles.ts` (add `canEditPrePrChecks`)
- Create: `apps/worker/src/pre-pr-checks/store.ts`
- Create: `apps/worker/src/pre-pr-checks/store.test.ts`
- Generated: `apps/worker/drizzle/0010_*.sql` (via `pnpm db:generate`)

**Interfaces:**
- Consumes: `createTestDb()` from `src/db/test-db.js`; `Db` from `src/db/client.js`; `DashboardAuthError(statusCode, message)` from `src/lib/auth/users-read.js`; `PrePrCheckConfig` from `src/pre-pr-checks/config.js`.
- Produces (used by Tasks 2–3):
  - `canEditPrePrChecks(role: DashboardRole): boolean`
  - `interface PrePrCheckConfigVersionRow { version: number; config: PrePrCheckConfig; createdAt: Date; createdById: string; createdByLabel: string; restoredFromVersion: number | null }`
  - `getCurrentPrePrCheckConfig(db: Db): Promise<PrePrCheckConfigVersionRow | null>`
  - `listPrePrCheckConfigVersions(db: Db): Promise<PrePrCheckConfigVersionRow[]>` (newest first, max 50)
  - `savePrePrCheckConfig(db: Db, input: { actorRole: DashboardRole; actorId: string; actorLabel: string; config: PrePrCheckConfig; restoredFromVersion?: number }): Promise<PrePrCheckConfigVersionRow>` (throws `DashboardAuthError(403)` for members)
  - `restorePrePrCheckConfig(db: Db, input: { actorRole: DashboardRole; actorId: string; actorLabel: string; version: number }): Promise<PrePrCheckConfigVersionRow>` (throws `DashboardAuthError(404)` for unknown versions)

- [ ] **Step 1: Add the table to the schema**

In `apps/worker/src/db/schema.ts`, add `serial` to the existing `drizzle-orm/pg-core` import list, add a type import, and append the table after `workflowOwnedBranches`:

```ts
import type { PrePrCheckConfig } from "../pre-pr-checks/config.js";
```

```ts
/**
 * Dashboard-managed pre-PR check configuration, append-only. The current
 * config is the row with the highest version; a rollback appends a copy of
 * an older version with restored_from_version set. No rows = gate disabled.
 */
export const prePrCheckConfigVersions = pgTable("pre_pr_check_config_versions", {
  version: serial("version").primaryKey(),
  config: jsonb("config").$type<PrePrCheckConfig>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: text("created_by_id").notNull(),
  createdByLabel: text("created_by_label").notNull(),
  restoredFromVersion: integer("restored_from_version"),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter worker db:generate`
Expected: a new `apps/worker/drizzle/0010_<name>.sql` containing `CREATE TABLE "pre_pr_check_config_versions"`. Inspect it; commit it as-is (do not hand-edit).

- [ ] **Step 3: Write the failing store test**

Create `apps/worker/src/pre-pr-checks/store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import type { PrePrCheckConfig } from "./config.js";
import {
  getCurrentPrePrCheckConfig,
  listPrePrCheckConfigVersions,
  restorePrePrCheckConfig,
  savePrePrCheckConfig,
} from "./store.js";

const CONFIG_A: PrePrCheckConfig = {
  repositories: [{ provider: "github", repoPath: "acme/web", commands: ["pnpm test"] }],
};
const CONFIG_B: PrePrCheckConfig = {
  repositories: [{ provider: "gitlab", repoPath: "acme/api", commands: ["bun test"] }],
};
const ACTOR = { actorRole: "admin" as const, actorId: "user_admin", actorLabel: "admin@example.com" };

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("pre-PR check config store", () => {
  it("returns null/empty when no config was ever saved", async () => {
    expect(await getCurrentPrePrCheckConfig(db)).toBeNull();
    expect(await listPrePrCheckConfigVersions(db)).toEqual([]);
  });

  it("appends versions and returns the latest as current", async () => {
    const v1 = await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_A });
    const v2 = await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_B });
    expect(v1.version).toBeLessThan(v2.version);

    const current = await getCurrentPrePrCheckConfig(db);
    expect(current?.version).toBe(v2.version);
    expect(current?.config).toEqual(CONFIG_B);
    expect(current?.createdByLabel).toBe("admin@example.com");

    const versions = await listPrePrCheckConfigVersions(db);
    expect(versions.map((v) => v.version)).toEqual([v2.version, v1.version]);
  });

  it("rejects writes from members with 403", async () => {
    await expect(
      savePrePrCheckConfig(db, { ...ACTOR, actorRole: "member", config: CONFIG_A }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("owner can write", async () => {
    const row = await savePrePrCheckConfig(db, { ...ACTOR, actorRole: "owner", config: CONFIG_A });
    expect(row.version).toBeGreaterThan(0);
  });

  it("restore appends a copy with the restored_from marker", async () => {
    const v1 = await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_A });
    await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_B });

    const restored = await restorePrePrCheckConfig(db, { ...ACTOR, version: v1.version });
    expect(restored.config).toEqual(CONFIG_A);
    expect(restored.restoredFromVersion).toBe(v1.version);

    const current = await getCurrentPrePrCheckConfig(db);
    expect(current?.version).toBe(restored.version);
  });

  it("restore of an unknown version fails with 404", async () => {
    await expect(restorePrePrCheckConfig(db, { ...ACTOR, version: 999 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/pre-pr-checks/store.test.ts`
Expected: FAIL — `Cannot find module './store.js'` (or equivalent resolution error).

- [ ] **Step 5: Add the role helper**

Append to `apps/worker/src/lib/auth/roles.ts`:

```ts
export function canEditPrePrChecks(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}
```

- [ ] **Step 6: Implement the store**

Create `apps/worker/src/pre-pr-checks/store.ts`:

```ts
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { prePrCheckConfigVersions } from "../db/schema.js";
import { canEditPrePrChecks, type DashboardRole } from "../lib/auth/roles.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";
import type { PrePrCheckConfig } from "./config.js";

const VERSION_LIST_LIMIT = 50;

export interface PrePrCheckConfigVersionRow {
  version: number;
  config: PrePrCheckConfig;
  createdAt: Date;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
}

export async function getCurrentPrePrCheckConfig(
  db: Db,
): Promise<PrePrCheckConfigVersionRow | null> {
  const rows = await db
    .select()
    .from(prePrCheckConfigVersions)
    .orderBy(desc(prePrCheckConfigVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPrePrCheckConfigVersions(
  db: Db,
): Promise<PrePrCheckConfigVersionRow[]> {
  return db
    .select()
    .from(prePrCheckConfigVersions)
    .orderBy(desc(prePrCheckConfigVersions.version))
    .limit(VERSION_LIST_LIMIT);
}

export interface SavePrePrCheckConfigInput {
  actorRole: DashboardRole;
  actorId: string;
  actorLabel: string;
  config: PrePrCheckConfig;
  restoredFromVersion?: number;
}

export async function savePrePrCheckConfig(
  db: Db,
  input: SavePrePrCheckConfigInput,
): Promise<PrePrCheckConfigVersionRow> {
  if (!canEditPrePrChecks(input.actorRole)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  const rows = await db
    .insert(prePrCheckConfigVersions)
    .values({
      config: input.config,
      createdById: input.actorId,
      createdByLabel: input.actorLabel,
      restoredFromVersion: input.restoredFromVersion ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function restorePrePrCheckConfig(
  db: Db,
  input: { actorRole: DashboardRole; actorId: string; actorLabel: string; version: number },
): Promise<PrePrCheckConfigVersionRow> {
  if (!canEditPrePrChecks(input.actorRole)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  const rows = await db
    .select()
    .from(prePrCheckConfigVersions)
    .where(eq(prePrCheckConfigVersions.version, input.version))
    .limit(1);
  const source = rows[0];
  if (!source) {
    throw new DashboardAuthError(404, "Unknown version");
  }
  return savePrePrCheckConfig(db, {
    actorRole: input.actorRole,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    config: source.config,
    restoredFromVersion: source.version,
  });
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter worker exec vitest run src/pre-pr-checks/store.test.ts`
Expected: PASS (6 tests). Also run `pnpm --filter worker typecheck` — expected clean.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/db/schema.ts apps/worker/drizzle apps/worker/src/lib/auth/roles.ts apps/worker/src/pre-pr-checks/store.ts apps/worker/src/pre-pr-checks/store.test.ts
git commit -m "Add versioned Postgres store for pre-PR check config"
```

---

### Task 2: Rewire the workflow read path and retire the env var

**Files:**
- Modify: `apps/worker/src/pre-pr-checks/config.ts` (export schema, add issue formatter, delete `parsePrePrCheckConfig`)
- Modify: `apps/worker/src/pre-pr-checks/config.test.ts` (rewrite for the schema)
- Modify: `apps/worker/src/workflows/agent.ts` (`runPrePrChecksStep`, around line 512 on dev)
- Modify: `apps/worker/env.ts` (remove `PRE_PR_CHECKS`, lines ~76-80 on dev)
- Modify: `apps/worker/.env.example` (remove the `PRE_PR_CHECKS` block)
- Modify: `SETUP.md` (remove the `PRE_PR_CHECKS` env-table row)

**Interfaces:**
- Consumes: `getCurrentPrePrCheckConfig` from Task 1.
- Produces (used by Task 3): `prePrCheckConfigSchema` (zod schema validating `{ repositories: [...] }`), `describePrePrCheckIssues(error: ZodError): string`, `emptyPrePrCheckConfig` (kept as-is). `parsePrePrCheckConfig` no longer exists.

- [ ] **Step 1: Rewrite the config tests to target the schema**

Replace the contents of `apps/worker/src/pre-pr-checks/config.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { describePrePrCheckIssues, prePrCheckConfigSchema } from "./config.js";

describe("prePrCheckConfigSchema", () => {
  it("accepts per-repo check commands", () => {
    const result = prePrCheckConfigSchema.safeParse({
      repositories: [
        { provider: "github", repoPath: "acme/web", commands: ["pnpm typecheck", "pnpm test"] },
        { provider: "gitlab", repoPath: "acme/api", commands: ["bun test"] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty repository list (gate disabled)", () => {
    expect(prePrCheckConfigSchema.safeParse({ repositories: [] }).success).toBe(true);
  });

  it("rejects a repository with no commands", () => {
    const result = prePrCheckConfigSchema.safeParse({
      repositories: [{ provider: "github", repoPath: "acme/web", commands: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys and bad providers", () => {
    expect(
      prePrCheckConfigSchema.safeParse({
        repositories: [{ provider: "svn", repoPath: "acme/web", commands: ["make"] }],
      }).success,
    ).toBe(false);
    expect(
      prePrCheckConfigSchema.safeParse({ repositories: [], extra: true }).success,
    ).toBe(false);
  });

  it("formats issues with their path", () => {
    const result = prePrCheckConfigSchema.safeParse({
      repositories: [{ provider: "github", repoPath: "", commands: ["x"] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(describePrePrCheckIssues(result.error)).toContain("repositories.0.repoPath");
    }
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm --filter worker exec vitest run src/pre-pr-checks/config.test.ts`
Expected: FAIL — `prePrCheckConfigSchema` / `describePrePrCheckIssues` are not exported.

- [ ] **Step 3: Update config.ts**

In `apps/worker/src/pre-pr-checks/config.ts`:
1. Rename the private `prePrCheckConfigSchema` const to an **exported** const (same zod definition, unchanged).
2. Delete `parsePrePrCheckConfig` and the private `errorMessage` helper.
3. Replace the private `formatPath` with an exported issue formatter. The resulting file:

```ts
import { z } from "zod";

export interface PrePrCheckRepositoryConfig {
  provider: "github" | "gitlab";
  repoPath: string;
  commands: string[];
}

export interface PrePrCheckConfig {
  repositories: PrePrCheckRepositoryConfig[];
}

export const emptyPrePrCheckConfig: PrePrCheckConfig = { repositories: [] };

export const prePrCheckConfigSchema = z
  .object({
    repositories: z.array(
      z
        .object({
          provider: z.enum(["github", "gitlab"]),
          repoPath: z.string().trim().min(1),
          commands: z.array(z.string().trim().min(1)).min(1),
        })
        .strict(),
    ).default([]),
  })
  .strict();

export function describePrePrCheckIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
}
```

- [ ] **Step 4: Run the config tests to verify they pass**

Run: `pnpm --filter worker exec vitest run src/pre-pr-checks/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Swap the workflow step to the DB read**

In `apps/worker/src/workflows/agent.ts`, replace the body of `runPrePrChecksStep` (keep the signature and `maxRetries = 0`):

```ts
async function runPrePrChecksStep(
  sandboxId: string,
  agentKind: AgentKind,
  model: string,
): Promise<{ passed: boolean; fixCycles: number; summary: string }> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { getCurrentPrePrCheckConfig } = await import("../pre-pr-checks/store.js");
  const { emptyPrePrCheckConfig } = await import("../pre-pr-checks/config.js");
  const { runPrePrChecksWithFixes } = await import("../pre-pr-checks/runner.js");
  const { logger } = await import("../lib/logger.js");
  const current = await getCurrentPrePrCheckConfig(getDb());
  logger.info(
    { version: current?.version ?? null },
    "pre_pr_checks_config_version",
  );
  return runPrePrChecksWithFixes(
    sandboxId,
    current?.config ?? emptyPrePrCheckConfig,
    agentKind,
    model,
  );
}
runPrePrChecksStep.maxRetries = 0;
```

- [ ] **Step 6: Remove the env var**

1. `apps/worker/env.ts`: delete the `PRE_PR_CHECKS: z.string().min(1).optional(),` line and its comment block ("Explicit per-repo commands run in the sandbox…").
2. `apps/worker/.env.example`: delete the 5-line block starting `# Pre-PR checks — optional explicit commands, no auto-discovery.` through `# PRE_PR_CHECKS={"repositories":…}`.
3. `SETUP.md`: delete the `| `PRE_PR_CHECKS` | unset | Optional JSON config … |` table row.

- [ ] **Step 7: Verify worker suite and typecheck**

Run: `pnpm --filter worker exec vitest run src/pre-pr-checks && pnpm --filter worker typecheck`
Expected: PASS (store, config, runner tests) and a clean typecheck. `grep -rn "PRE_PR_CHECKS" apps/worker/src apps/worker/env.ts apps/worker/.env.example SETUP.md` must return nothing.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/pre-pr-checks/config.ts apps/worker/src/pre-pr-checks/config.test.ts apps/worker/src/workflows/agent.ts apps/worker/env.ts apps/worker/.env.example SETUP.md
git commit -m "Read pre-PR check config from Postgres and retire PRE_PR_CHECKS"
```

---

### Task 3: Shared contracts + worker config API + session flag

**Files:**
- Modify: `apps/shared/contracts/domain.ts` (append types)
- Modify: `apps/shared/contracts/api.ts` (append response types)
- Create: `apps/worker/src/routes/api/v1/pre-pr-checks.get.ts`
- Create: `apps/worker/src/routes/api/v1/pre-pr-checks.put.ts`
- Create: `apps/worker/src/routes/api/v1/pre-pr-checks/restore.post.ts`
- Modify: `apps/worker/src/routes/api/v1/session.get.ts` (add `canEditChecks`)
- Modify: `apps/worker/src/pre-pr-checks/store.ts` (add serializer)
- Create: `apps/worker/src/routes/api/v1/pre-pr-checks.test.ts`

**Interfaces:**
- Consumes: store functions from Task 1; `prePrCheckConfigSchema`, `describePrePrCheckIssues` from Task 2; `requireDashboardActor` (returns `{ organizationId, organizationName, memberId, userId, role }`), `toHttpError`, `canEditPrePrChecks`.
- Produces (used by Tasks 5–6):
  - `@shared/contracts`: `PrePrCheckRepositoryConfig`, `PrePrCheckConfig`, `PrePrCheckConfigVersion { version: number; config; createdAt: string; createdById: string; createdByLabel: string; restoredFromVersion: number | null }`, `PrePrChecksResponse { current: PrePrCheckConfigVersion | null; versions: PrePrCheckConfigVersion[] }`, `PrePrCheckSaveResponse { version: PrePrCheckConfigVersion }`
  - Worker: `GET /api/v1/pre-pr-checks` → `PrePrChecksResponse`; `PUT /api/v1/pre-pr-checks` body `{ config }` → `PrePrCheckSaveResponse` (400 invalid, 403 member); `POST /api/v1/pre-pr-checks/restore` body `{ version }` → `PrePrCheckSaveResponse` (404 unknown); `GET /api/v1/session` now includes `canEditChecks: boolean`
  - `serializePrePrCheckConfigVersion(row): PrePrCheckConfigVersion` exported from `store.ts`

- [ ] **Step 1: Add the contract types**

Append to `apps/shared/contracts/domain.ts`:

```ts
// --- Pre-PR checks (dashboard-managed gate config) ---

export type VcsProviderKind = "github" | "gitlab";

export interface PrePrCheckRepositoryConfig {
  provider: VcsProviderKind;
  repoPath: string;
  commands: string[];
}

export interface PrePrCheckConfig {
  repositories: PrePrCheckRepositoryConfig[];
}

export interface PrePrCheckConfigVersion {
  version: number;
  config: PrePrCheckConfig;
  /** ISO timestamp. */
  createdAt: string;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
}
```

Append to `apps/shared/contracts/api.ts` (and add `PrePrCheckConfigVersion` to the type import from `./domain.js`):

```ts
export interface PrePrChecksResponse {
  current: PrePrCheckConfigVersion | null;
  /** Newest first, capped at 50. */
  versions: PrePrCheckConfigVersion[];
}

export interface PrePrCheckSaveResponse {
  version: PrePrCheckConfigVersion;
}
```

- [ ] **Step 2: Write the failing route tests**

Create `apps/worker/src/routes/api/v1/pre-pr-checks.test.ts` (mirrors `invites.test.ts`: pglite DB, mocked env/db/auth):

```ts
import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import { savePrePrCheckConfig } from "../../../pre-pr-checks/store.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));

const checksGet = (await import("./pre-pr-checks.get.js")).default;
const checksPut = (await import("./pre-pr-checks.put.js")).default;
const restorePost = (await import("./pre-pr-checks/restore.post.js")).default;
const sessionGet = (await import("./session.get.js")).default;

const VALID_CONFIG = {
  repositories: [{ provider: "github", repoPath: "acme/web", commands: ["pnpm test"] }],
};
const ACTOR = { actorRole: "admin" as const, actorId: "user_admin", actorLabel: "Admin" };

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://worker.test/", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
    { id: "member_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
});

describe("GET /api/v1/pre-pr-checks", () => {
  it("returns empty state when nothing was saved", async () => {
    const res = await handlerFor(checksGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ current: null, versions: [] });
  });

  it("returns current + versions newest first", async () => {
    await savePrePrCheckConfig(db, { ...ACTOR, config: { repositories: [] } });
    await savePrePrCheckConfig(db, { ...ACTOR, config: VALID_CONFIG });
    const res = await handlerFor(checksGet)(new Request("http://worker.test/"));
    const body = await res.json();
    expect(body.current.version).toBe(2);
    expect(body.current.config).toEqual(VALID_CONFIG);
    expect(typeof body.current.createdAt).toBe("string");
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });
});

describe("PUT /api/v1/pre-pr-checks", () => {
  it("saves a valid config and returns the new version", async () => {
    const res = await handlerFor(checksPut)(jsonRequest("PUT", { config: VALID_CONFIG }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.version).toBe(1);
    expect(body.version.config).toEqual(VALID_CONFIG);
    expect(body.version.createdByLabel).toBe("Admin");
  });

  it("rejects invalid config with 400 and named field", async () => {
    const res = await handlerFor(checksPut)(
      jsonRequest("PUT", {
        config: { repositories: [{ provider: "github", repoPath: "acme/web", commands: [] }] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await handlerFor(checksPut)(jsonRequest("PUT", { config: VALID_CONFIG }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/pre-pr-checks/restore", () => {
  it("appends a copy of the requested version", async () => {
    await savePrePrCheckConfig(db, { ...ACTOR, config: VALID_CONFIG });
    await savePrePrCheckConfig(db, { ...ACTOR, config: { repositories: [] } });
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.version).toBe(3);
    expect(body.version.config).toEqual(VALID_CONFIG);
    expect(body.version.restoredFromVersion).toBe(1);
  });

  it("404s on an unknown version", async () => {
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 42 }));
    expect(res.status).toBe(404);
  });

  it("rejects members with 403", async () => {
    await savePrePrCheckConfig(db, { ...ACTOR, config: VALID_CONFIG });
    state.sessionUserId = "user_member";
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 1 }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/session", () => {
  it("reports canEditChecks per role", async () => {
    let res = await handlerFor(sessionGet)(new Request("http://worker.test/"));
    expect((await res.json()).canEditChecks).toBe(true);

    state.sessionUserId = "user_member";
    res = await handlerFor(sessionGet)(new Request("http://worker.test/"));
    expect((await res.json()).canEditChecks).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter worker exec vitest run src/routes/api/v1/pre-pr-checks.test.ts`
Expected: FAIL — cannot resolve `./pre-pr-checks.get.js`.

- [ ] **Step 4: Add the serializer and user-label helper to the store**

Append to `apps/worker/src/pre-pr-checks/store.ts` (imports go to the top of the file; `eq` is already imported, add `user` to the schema import):

```ts
import type { PrePrCheckConfigVersion } from "@shared/contracts";
import { prePrCheckConfigVersions, user } from "../db/schema.js";

export function serializePrePrCheckConfigVersion(
  row: PrePrCheckConfigVersionRow,
): PrePrCheckConfigVersion {
  return {
    version: row.version,
    config: row.config,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
}

/** Display label for the audit trail: name, falling back to email, then id. */
export async function dashboardUserLabel(db: Db, userId: string): Promise<string> {
  const rows = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  return row?.name?.trim() || row?.email || userId;
}
```

- [ ] **Step 5: Implement the three routes and the session flag**

Create `apps/worker/src/routes/api/v1/pre-pr-checks.get.ts`:

```ts
import { defineEventHandler } from "h3";
import type { PrePrChecksResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import {
  listPrePrCheckConfigVersions,
  serializePrePrCheckConfigVersion,
} from "../../../pre-pr-checks/store.js";

export default defineEventHandler(async (event): Promise<PrePrChecksResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    const versions = (await listPrePrCheckConfigVersions(getDb())).map(
      serializePrePrCheckConfigVersion,
    );
    return { current: versions[0] ?? null, versions };
  } catch (error) {
    toHttpError(error);
  }
});
```

Create `apps/worker/src/routes/api/v1/pre-pr-checks.put.ts`:

```ts
import { createError, defineEventHandler, readBody } from "h3";
import type { PrePrCheckSaveResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import {
  describePrePrCheckIssues,
  prePrCheckConfigSchema,
} from "../../../pre-pr-checks/config.js";
import {
  savePrePrCheckConfig,
  serializePrePrCheckConfigVersion,
} from "../../../pre-pr-checks/store.js";

export default defineEventHandler(async (event): Promise<PrePrCheckSaveResponse | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    const body = (await readBody<{ config?: unknown }>(event).catch(() => null)) ?? {};
    const parsed = prePrCheckConfigSchema.safeParse(body.config);
    if (!parsed.success) {
      throw createError({
        statusCode: 400,
        statusMessage: `Invalid config: ${describePrePrCheckIssues(parsed.error)}`,
      });
    }
    const dbHandle = getDb();
    const saved = await savePrePrCheckConfig(dbHandle, {
      actorRole: actor.role,
      actorId: actor.userId,
      actorLabel: await dashboardUserLabel(dbHandle, actor.userId),
      config: parsed.data,
    });
    return { version: serializePrePrCheckConfigVersion(saved) };
  } catch (error) {
    toHttpError(error);
  }
});
```

(Add `dashboardUserLabel` to the store import list. `DashboardActor` carries only `userId` — the label is looked up from the `user` table by the Step 4 helper; the route test's `createdByLabel: "Admin"` assertion covers it since the seeded user's name is "Admin".)

Create `apps/worker/src/routes/api/v1/pre-pr-checks/restore.post.ts`:

```ts
import { createError, defineEventHandler, readBody } from "h3";
import type { PrePrCheckSaveResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import {
  dashboardUserLabel,
  restorePrePrCheckConfig,
  serializePrePrCheckConfigVersion,
} from "../../../../pre-pr-checks/store.js";

export default defineEventHandler(async (event): Promise<PrePrCheckSaveResponse | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    const body = (await readBody<{ version?: unknown }>(event).catch(() => null)) ?? {};
    if (typeof body.version !== "number" || !Number.isInteger(body.version)) {
      throw createError({ statusCode: 400, statusMessage: "Invalid version" });
    }
    const dbHandle = getDb();
    const restored = await restorePrePrCheckConfig(dbHandle, {
      actorRole: actor.role,
      actorId: actor.userId,
      actorLabel: await dashboardUserLabel(dbHandle, actor.userId),
      version: body.version,
    });
    return { version: serializePrePrCheckConfigVersion(restored) };
  } catch (error) {
    toHttpError(error);
  }
});
```

Modify `apps/worker/src/routes/api/v1/session.get.ts`:

```ts
import { defineEventHandler } from "h3";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import { canEditPrePrChecks, canInvite } from "../../../lib/auth/roles.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    return {
      organizationName: actor.organizationName,
      role: actor.role,
      canManageUsers: canInvite(actor.role),
      canEditChecks: canEditPrePrChecks(actor.role),
    };
  } catch (error) {
    toHttpError(error);
  }
});
```

- [ ] **Step 6: Run the route tests**

Run: `pnpm --filter worker exec vitest run src/routes/api/v1/pre-pr-checks.test.ts src/pre-pr-checks/store.test.ts`
Expected: PASS. Then `pnpm --filter worker typecheck` — clean.

- [ ] **Step 7: Commit**

```bash
git add apps/shared/contracts apps/worker/src/routes/api/v1/pre-pr-checks.get.ts apps/worker/src/routes/api/v1/pre-pr-checks.put.ts apps/worker/src/routes/api/v1/pre-pr-checks apps/worker/src/routes/api/v1/session.get.ts apps/worker/src/routes/api/v1/pre-pr-checks.test.ts apps/worker/src/pre-pr-checks/store.ts
git commit -m "Add pre-PR checks config API and session capability flag"
```

---

### Task 4: Repositories endpoint (picker data source)

**Files:**
- Modify: `apps/shared/contracts/domain.ts` (add `RepositoryOption`)
- Modify: `apps/shared/contracts/api.ts` (add `RepositoriesResponse`)
- Create: `apps/worker/src/routes/api/v1/repositories.get.ts`
- Create: `apps/worker/src/routes/api/v1/repositories.test.ts`

**Interfaces:**
- Consumes: `createRepositoryDirectoryForProviders(providers)` and `RepositoryMetadata` from `src/adapters/vcs/repository-directory.js`; `getConfiguredVcsProviders()` from `apps/worker/env.ts`.
- Produces (used by Tasks 5–6): `GET /api/v1/repositories` → `RepositoriesResponse { repositories: RepositoryOption[] }`; `RepositoryOption { provider: VcsProviderKind; repoPath: string; name: string; owner: string; defaultBranch: string; private: boolean; archived: boolean }`; exported `resetRepositoriesCacheForTests()`.

- [ ] **Step 1: Add contracts**

Append to `apps/shared/contracts/domain.ts`:

```ts
export interface RepositoryOption {
  provider: VcsProviderKind;
  repoPath: string;
  name: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
}
```

Append to `apps/shared/contracts/api.ts` (add `RepositoryOption` to the domain import):

```ts
export interface RepositoriesResponse {
  repositories: RepositoryOption[];
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/worker/src/routes/api/v1/repositories.test.ts`:

```ts
import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_member",
  listRepositories: vi.fn(),
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../../env.js", () => ({
  env: state.env,
  getConfiguredVcsProviders: () => [{ kind: "github" }],
}));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));
vi.mock("../../../adapters/vcs/repository-directory.js", () => ({
  createRepositoryDirectoryForProviders: () => ({
    listRepositories: state.listRepositories,
  }),
}));

const repositoriesGet = (await import("./repositories.get.js")).default;
const { resetRepositoriesCacheForTests } = await import("./repositories.get.js");

const REPO = {
  provider: "github",
  repoPath: "acme/web",
  name: "web",
  owner: "acme",
  defaultBranch: "main",
  description: "",
  webUrl: "https://github.com/acme/web",
  topics: [],
  archived: false,
  private: true,
};

function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

let db: Db;

beforeEach(async () => {
  vi.clearAllMocks();
  resetRepositoriesCacheForTests();
  state.listRepositories.mockResolvedValue([REPO]);
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
});

describe("GET /api/v1/repositories", () => {
  it("maps directory metadata to picker options (members allowed)", async () => {
    const res = await handlerFor(repositoriesGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          name: "web",
          owner: "acme",
          defaultBranch: "main",
          private: true,
          archived: false,
        },
      ],
    });
  });

  it("serves the second request from cache", async () => {
    const handler = handlerFor(repositoriesGet);
    await handler(new Request("http://worker.test/"));
    await handler(new Request("http://worker.test/"));
    expect(state.listRepositories).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter worker exec vitest run src/routes/api/v1/repositories.test.ts`
Expected: FAIL — cannot resolve `./repositories.get.js`.

- [ ] **Step 4: Implement the route**

Create `apps/worker/src/routes/api/v1/repositories.get.ts`:

```ts
import { defineEventHandler } from "h3";
import type { RepositoriesResponse, RepositoryOption } from "@shared/contracts";
import { getConfiguredVcsProviders } from "../../../../env.js";
import { createRepositoryDirectoryForProviders } from "../../../adapters/vcs/repository-directory.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";

const CACHE_TTL_MS = 60_000;

let cache: { at: number; repositories: RepositoryOption[] } | null = null;

export function resetRepositoriesCacheForTests(): void {
  cache = null;
}

export default defineEventHandler(async (event): Promise<RepositoriesResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return { repositories: cache.repositories };
    }
    const directory = createRepositoryDirectoryForProviders(getConfiguredVcsProviders());
    const repositories = (await directory.listRepositories()).map(
      (repo): RepositoryOption => ({
        provider: repo.provider,
        repoPath: repo.repoPath,
        name: repo.name,
        owner: repo.owner,
        defaultBranch: repo.defaultBranch,
        private: repo.private,
        archived: repo.archived,
      }),
    );
    cache = { at: Date.now(), repositories };
    return { repositories };
  } catch (error) {
    toHttpError(error);
  }
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter worker exec vitest run src/routes/api/v1/repositories.test.ts && pnpm --filter worker typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add apps/shared/contracts apps/worker/src/routes/api/v1/repositories.get.ts apps/worker/src/routes/api/v1/repositories.test.ts
git commit -m "Expose accessible repositories for the pre-PR checks picker"
```

---

### Task 5: Dashboard BFF routes + session type

**Files:**
- Modify: `apps/dashboard/lib/auth/session.ts` (add `canEditChecks`)
- Create: `apps/dashboard/app/api/pre-pr-checks/handler.ts`
- Create: `apps/dashboard/app/api/pre-pr-checks/route.ts`
- Create: `apps/dashboard/app/api/pre-pr-checks/restore/route.ts`
- Create: `apps/dashboard/app/api/repositories/route.ts`
- Create: `apps/dashboard/app/api/pre-pr-checks/route.test.ts`

**Interfaces:**
- Consumes: `proxyWorker(path, init?)` from `@/lib/api/proxy`; worker endpoints from Tasks 3–4.
- Produces (used by Task 6): same-origin `GET/PUT /api/pre-pr-checks`, `POST /api/pre-pr-checks/restore`, `GET /api/repositories`; `DashboardSession.canEditChecks: boolean`.

- [ ] **Step 1: Extend the dashboard session type**

In `apps/dashboard/lib/auth/session.ts`, add `canEditChecks: boolean;` to `DashboardSession` and extend the validator:

```ts
export type DashboardSession = {
  organizationName: string;
  role: "owner" | "admin" | "member";
  canManageUsers: boolean;
  canEditChecks: boolean;
};
```

and in `isDashboardSession`, add to the returned condition:

```ts
    typeof session.canManageUsers === "boolean" &&
    typeof session.canEditChecks === "boolean"
```

- [ ] **Step 2: Write the failing handler tests**

Create `apps/dashboard/app/api/pre-pr-checks/route.test.ts` (node:test, mirroring `app/api/users/[userId]/role/route.test.ts`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { handlePrePrChecksGet, handlePrePrChecksPut, handlePrePrChecksRestore } from "./handler.ts";

test("GET forwards to the worker and re-serializes status", async () => {
  const res = await handlePrePrChecksGet(async (path, init) => {
    assert.equal(path, "/api/v1/pre-pr-checks");
    assert.equal(init?.method ?? "GET", "GET");
    return Response.json({ current: null, versions: [] }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { current: null, versions: [] });
});

test("PUT forwards the JSON body and worker status", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handlePrePrChecksPut(
    new Request("https://dashboard.example.com/api/pre-pr-checks", {
      method: "PUT",
      body: JSON.stringify({ config: { repositories: [] } }),
    }),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ error: "Invalid config" }, { status: 400 });
    },
  );
  assert.equal(res.status, 400);
  assert.equal(calls[0].path, "/api/v1/pre-pr-checks");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { config: { repositories: [] } });
});

test("restore maps worker timeouts to 504", async () => {
  const res = await handlePrePrChecksRestore(
    new Request("https://dashboard.example.com/api/pre-pr-checks/restore", {
      method: "POST",
      body: JSON.stringify({ version: 3 }),
    }),
    async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  );
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: "Worker request timed out" });
});
```

- [ ] **Step 3: Run to verify failure**

Run (from `apps/dashboard/`): `node --test app/api/pre-pr-checks/route.test.ts`
Expected: FAIL — cannot find `./handler.ts`.

- [ ] **Step 4: Implement handler + routes**

Create `apps/dashboard/app/api/pre-pr-checks/handler.ts`:

```ts
import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;

export async function handlePrePrChecksGet(workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/pre-pr-checks", { method: "GET" });
}

export async function handlePrePrChecksPut(req: Request, workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/pre-pr-checks", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handlePrePrChecksRestore(req: Request, workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/pre-pr-checks/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handleRepositoriesGet(workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/repositories", { method: "GET" });
}

async function forward(workerProxy: WorkerProxy, path: string, init: RequestInit) {
  try {
    const res = await workerProxy(path, init);
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch (error) {
    if (isWorkerTimeoutError(error)) {
      return NextResponse.json({ error: "Worker request timed out" }, { status: 504 });
    }
    throw error;
  }
}

function isWorkerTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; name?: unknown };
  return maybeError.name === "TimeoutError" || maybeError.code === 23;
}
```

Create `apps/dashboard/app/api/pre-pr-checks/route.ts`:

```ts
import { proxyWorker } from "@/lib/api/proxy";
import { handlePrePrChecksGet, handlePrePrChecksPut } from "./handler";

export async function GET() {
  return handlePrePrChecksGet(proxyWorker);
}

export async function PUT(req: Request) {
  return handlePrePrChecksPut(req, proxyWorker);
}
```

Create `apps/dashboard/app/api/pre-pr-checks/restore/route.ts`:

```ts
import { proxyWorker } from "@/lib/api/proxy";
import { handlePrePrChecksRestore } from "../handler";

export async function POST(req: Request) {
  return handlePrePrChecksRestore(req, proxyWorker);
}
```

Create `apps/dashboard/app/api/repositories/route.ts`:

```ts
import { proxyWorker } from "@/lib/api/proxy";
import { handleRepositoriesGet } from "../pre-pr-checks/handler";

export async function GET() {
  return handleRepositoriesGet(proxyWorker);
}
```

- [ ] **Step 5: Run tests + typecheck**

Run (from `apps/dashboard/`): `node --test app/api/pre-pr-checks/route.test.ts`
Expected: PASS (3 tests).
Run (from repo root): `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/lib/auth/session.ts apps/dashboard/app/api/pre-pr-checks apps/dashboard/app/api/repositories
git commit -m "Add dashboard BFF routes for pre-PR checks config"
```

---

### Task 6: Dashboard screen, nav entry, and page

**Files:**
- Modify: `apps/dashboard/components/cockpit/chrome.tsx` (nav entry; rename `flow` group label)
- Create: `apps/dashboard/components/cockpit/screens/pre-pr-checks.tsx`
- Create: `apps/dashboard/app/checks-data.tsx`
- Create: `apps/dashboard/app/(cockpit)/checks/page.tsx`

**Interfaces:**
- Consumes: BFF routes from Task 5; `PrePrChecksResponse`, `PrePrCheckConfigVersion`, `PrePrCheckRepositoryConfig`, `RepositoryOption`, `RepositoriesResponse`, `PrePrCheckSaveResponse` from `@shared/contracts`; `getJSON`, `requireSession`, `readErrorMessage`.
- Produces: `/checks` cockpit page; nav id `checks` (visible to all roles — members get read-only).

- [ ] **Step 1: Add the nav entry**

In `apps/dashboard/components/cockpit/chrome.tsx`:

```ts
const NAV = [
  { id: "overview", label: "Overview", glyph: "◇", group: "obs" },
  { id: "runs", label: "Workflow runs", glyph: "≡", group: "obs" },
  { id: "prompts", label: "Prompts", glyph: "❡", group: "obs" },
  { id: "evals", label: "Arthur evals", glyph: "✓", group: "obs" },
  { id: "cost", label: "Cost & usage", glyph: "$", group: "obs" },
  { id: "editor", label: "Workflow editor", glyph: "▷", group: "flow" },
  { id: "checks", label: "Pre-PR checks", glyph: "☑", group: "flow" },
  { id: "users", label: "Users", glyph: "U", group: "team" },
];

const NAV_GROUPS = [
  { id: "obs", label: "Observability" },
  { id: "flow", label: "Workflow" },
  { id: "team", label: "Users" },
];

export const MOBILE_MORE_NAV_IDS = ["prompts", "evals", "cost", "checks", "users"] as const;
```

(No gating change: `cockpitNavItems` keeps filtering only `users`; `pathForScreen` in `cockpit-shell.tsx` already maps `checks` → `/checks` generically.)

- [ ] **Step 2: Create the screen component**

Create `apps/dashboard/components/cockpit/screens/pre-pr-checks.tsx`:

```tsx
"use client";

import React, { useState } from "react";
import type {
  PrePrCheckConfigVersion,
  PrePrCheckRepositoryConfig,
  PrePrChecksResponse,
  PrePrCheckSaveResponse,
  RepositoriesResponse,
  RepositoryOption,
} from "@shared/contracts";
import { readErrorMessage } from "@/lib/api/error-message";

export function PrePrChecksScreen({
  initial,
  canEdit,
}: {
  initial: PrePrChecksResponse;
  canEdit: boolean;
}) {
  const [repos, setRepos] = useState<PrePrCheckRepositoryConfig[]>(
    structuredClone(initial.current?.config.repositories ?? []),
  );
  const [versions, setVersions] = useState<PrePrCheckConfigVersion[]>(initial.versions);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);

  const savedRepos = versions[0]?.config.repositories ?? [];
  const dirty = JSON.stringify(repos) !== JSON.stringify(savedRepos);
  const valid = repos.every(
    (r) => r.commands.length > 0 && r.commands.every((c) => c.trim().length > 0),
  );

  function applyVersion(version: PrePrCheckConfigVersion) {
    setVersions((prev) => [version, ...prev]);
    setRepos(structuredClone(version.config.repositories));
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const res = await fetch("/api/pre-pr-checks", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { repositories: repos } }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      applyVersion(((await res.json()) as PrePrCheckSaveResponse).version);
    } finally {
      setBusy(null);
    }
  }

  async function restore(version: number) {
    setBusy(`restore-${version}`);
    setError(null);
    try {
      const res = await fetch("/api/pre-pr-checks/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      applyVersion(((await res.json()) as PrePrCheckSaveResponse).version);
      setConfirmRestore(null);
    } finally {
      setBusy(null);
    }
  }

  function updateRepo(index: number, next: PrePrCheckRepositoryConfig) {
    setRepos((prev) => prev.map((r, i) => (i === index ? next : r)));
  }

  return (
    <div className="p-6 max-w-[860px]">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="font-body text-[18px] font-semibold text-neutral-900">Pre-PR checks</h1>
        {canEdit && (
          <button
            onClick={save}
            disabled={!dirty || !valid || busy !== null}
            className="appearance-none border-none rounded-[3px] px-4 py-2 font-body text-[13px] font-semibold cursor-pointer bg-mariner text-white disabled:opacity-40 disabled:cursor-default"
          >
            {busy === "save" ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>
      <p className="font-body text-[13px] text-neutral-600 mb-4">
        Commands run inside the sandbox for changed repositories after implementation and before
        branch push / PR creation. Failed checks trigger up to 3 agent fix cycles, then block
        publication.
      </p>
      {error && (
        <div className="mb-3 rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[12px] text-red-700">
          {error}
        </div>
      )}
      {!canEdit && (
        <div className="mb-3 rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          Read-only — ask an admin or owner to change pre-PR checks.
        </div>
      )}

      {repos.length === 0 && (
        <div className="rounded-[3px] border border-dashed border-neutral-300 px-4 py-6 font-body text-[13px] text-neutral-500 mb-3">
          No pre-PR checks configured. The gate is disabled.
        </div>
      )}

      {repos.map((repo, index) => (
        <div key={`${repo.provider}:${repo.repoPath}`} className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-mono text-[13px] text-neutral-900">
              {repo.repoPath}
              <span className="ml-2 rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-600">
                {repo.provider}
              </span>
            </div>
            {canEdit && (
              <button
                onClick={() => setRepos((prev) => prev.filter((_, i) => i !== index))}
                className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 hover:text-red-600 cursor-pointer"
              >
                Remove
              </button>
            )}
          </div>
          {repo.commands.map((command, ci) => (
            <div key={ci} className="flex items-center gap-2 mb-[6px]">
              <span className="font-mono text-[11px] text-neutral-400 w-4 text-right">{ci + 1}.</span>
              <input
                value={command}
                disabled={!canEdit}
                onChange={(e) =>
                  updateRepo(index, {
                    ...repo,
                    commands: repo.commands.map((c, i) => (i === ci ? e.target.value : c)),
                  })
                }
                placeholder="pnpm test"
                className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px] text-neutral-900 disabled:bg-app-bg"
              />
              {canEdit && (
                <button
                  onClick={() =>
                    updateRepo(index, {
                      ...repo,
                      commands: repo.commands.filter((_, i) => i !== ci),
                    })
                  }
                  aria-label="Remove command"
                  className="appearance-none border-none bg-transparent font-mono text-[13px] text-neutral-400 hover:text-red-600 cursor-pointer"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <button
              onClick={() => updateRepo(index, { ...repo, commands: [...repo.commands, ""] })}
              className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer px-0"
            >
              + Add command
            </button>
          )}
        </div>
      ))}

      {canEdit && (
        <AddRepository
          configured={repos}
          onAdd={(repo) => setRepos((prev) => [...prev, { ...repo, commands: [""] }])}
        />
      )}

      <h2 className="font-body text-[14px] font-semibold text-neutral-900 mt-8 mb-2">History</h2>
      {versions.length === 0 && (
        <div className="font-body text-[12px] text-neutral-500">No versions yet.</div>
      )}
      {versions.map((v) => (
        <div
          key={v.version}
          className="flex items-center gap-3 border-b border-neutral-100 py-2 font-body text-[12px] text-neutral-700"
        >
          <span className="font-mono text-neutral-900">v{v.version}</span>
          <span>{v.createdByLabel}</span>
          <span className="text-neutral-400">{new Date(v.createdAt).toLocaleString()}</span>
          {v.restoredFromVersion !== null && (
            <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] text-neutral-600">
              restored from v{v.restoredFromVersion}
            </span>
          )}
          {canEdit && v.version !== versions[0]?.version && (
            <span className="ml-auto">
              {confirmRestore === v.version ? (
                <>
                  <button
                    onClick={() => restore(v.version)}
                    disabled={busy !== null}
                    className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
                  >
                    {busy === `restore-${v.version}` ? "Restoring…" : "Confirm restore"}
                  </button>
                  <button
                    onClick={() => setConfirmRestore(null)}
                    className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer ml-2"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmRestore(v.version)}
                  className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer"
                >
                  Restore
                </button>
              )}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function AddRepository({
  configured,
  onAdd,
}: {
  configured: PrePrCheckRepositoryConfig[];
  onAdd: (repo: { provider: "github" | "gitlab"; repoPath: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RepositoryOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [manualProvider, setManualProvider] = useState<"github" | "gitlab">("github");
  const [manualPath, setManualPath] = useState("");

  const isConfigured = (provider: string, repoPath: string) =>
    configured.some((r) => r.provider === provider && r.repoPath === repoPath);

  async function openPicker() {
    setOpen(true);
    if (options || failed) return;
    try {
      const res = await fetch("/api/repositories");
      if (!res.ok) throw new Error("failed");
      setOptions(((await res.json()) as RepositoriesResponse).repositories);
    } catch {
      setFailed(true);
    }
  }

  function addManual() {
    const repoPath = manualPath.trim();
    if (!repoPath || isConfigured(manualProvider, repoPath)) return;
    onAdd({ provider: manualProvider, repoPath });
    setManualPath("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        onClick={openPicker}
        className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-3 py-2 font-body text-[13px] text-neutral-800 cursor-pointer hover:bg-app-bg"
      >
        + Add repository
      </button>
    );
  }

  return (
    <div className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="font-body text-[13px] font-semibold text-neutral-900">Add repository</span>
        <button
          onClick={() => setOpen(false)}
          className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
        >
          Close
        </button>
      </div>
      {options === null && !failed && (
        <div className="font-body text-[12px] text-neutral-500 py-2">Loading repositories…</div>
      )}
      {options && (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="w-full rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px] mb-2"
          />
          <div className="max-h-[220px] overflow-y-auto">
            {options
              .filter((o) => !o.archived)
              .filter((o) => o.repoPath.toLowerCase().includes(filter.toLowerCase()))
              .map((o) => {
                const taken = isConfigured(o.provider, o.repoPath);
                return (
                  <button
                    key={`${o.provider}:${o.repoPath}`}
                    disabled={taken}
                    onClick={() => {
                      onAdd({ provider: o.provider, repoPath: o.repoPath });
                      setOpen(false);
                    }}
                    className="w-full appearance-none border-none bg-transparent text-left flex items-center gap-2 px-1 py-[6px] font-mono text-[12px] text-neutral-800 cursor-pointer hover:bg-app-bg rounded-[3px] disabled:opacity-40 disabled:cursor-default"
                  >
                    {o.repoPath}
                    <span className="rounded-[3px] bg-app-bg px-[5px] py-[1px] font-mono text-[10px] uppercase text-neutral-500">
                      {o.provider}
                    </span>
                    {taken && <span className="ml-auto font-body text-[11px] text-neutral-400">added</span>}
                  </button>
                );
              })}
          </div>
        </>
      )}
      {failed && (
        <div className="flex items-center gap-2 pt-1">
          <span className="font-body text-[12px] text-neutral-500">
            Couldn't list repositories — enter manually:
          </span>
          <select
            value={manualProvider}
            onChange={(e) => setManualProvider(e.target.value as "github" | "gitlab")}
            className="rounded-[3px] border border-neutral-200 bg-white px-1 py-[5px] font-mono text-[12px]"
          >
            <option value="github">github</option>
            <option value="gitlab">gitlab</option>
          </select>
          <input
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            placeholder="owner/repo"
            className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[5px] font-mono text-[12px]"
          />
          <button
            onClick={addManual}
            className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-2 py-[5px] font-body text-[12px] cursor-pointer"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create the data loader and page**

Create `apps/dashboard/app/checks-data.tsx`:

```tsx
import { redirect } from "next/navigation";

import { getJSON } from "@/lib/api/server";
import { UnauthorizedError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/session";
import { PrePrChecksScreen } from "@/components/cockpit/screens/pre-pr-checks";
import type { PrePrChecksResponse } from "@shared/contracts";

export async function ChecksData() {
  try {
    const [session, checks] = await Promise.all([
      requireSession(),
      getJSON<PrePrChecksResponse>("/api/v1/pre-pr-checks"),
    ]);
    return <PrePrChecksScreen initial={checks} canEdit={session.canEditChecks} />;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    throw error;
  }
}
```

Create `apps/dashboard/app/(cockpit)/checks/page.tsx`:

```tsx
import { Suspense } from "react";

import { ChecksData } from "@/app/checks-data";

export default function ChecksPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 font-mono text-[12px] text-neutral-500">Loading pre-PR checks…</div>
      }
    >
      <ChecksData />
    </Suspense>
  );
}
```

- [ ] **Step 4: Typecheck and manual smoke**

Run: `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
Expected: clean.

Manual smoke (needs a worker with `DATABASE_URL` + dashboard auth env): `pnpm dev` (worker) and `pnpm dev:dashboard`, log in, open `/checks`, add a repo + command, Save, confirm a v1 row appears in History; edit and Save again; Restore v1 and confirm a v3 "restored from v1" row. If local env isn't configured, state that the smoke was skipped in the task report.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/components/cockpit/chrome.tsx apps/dashboard/components/cockpit/screens/pre-pr-checks.tsx apps/dashboard/app/checks-data.tsx "apps/dashboard/app/(cockpit)/checks"
git commit -m "Add Pre-PR checks cockpit screen with repo picker and history"
```

---

### Task 7: Docs + full verification

**Files:**
- Modify: `README.md` (step-table row; diagram label if present)
- Modify: `SETUP.md` (add a pointer to the dashboard page)
- Modify: `docs/SPEC.md` (**only if** it contains "Pre-PR Checks (optional gate)" — see Global Constraints)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update README**

In the workflow step table, replace the `runPrePrChecksStep` row description with:

```markdown
| `runPrePrChecksStep` | Optional — runs dashboard-configured pre-PR check commands (cockpit → Pre-PR checks) for changed repositories before branch push / PR creation; failed checks trigger up to 3 agent fix cycles, then block publication |
```

If the README's mermaid diagram contains `GATE["runPrePrChecksStep (optional PRE_PR_CHECKS)"]`, change the label to `GATE["runPrePrChecksStep (optional, dashboard-configured)"]`.

- [ ] **Step 2: Update SETUP.md**

Where the `PRE_PR_CHECKS` row was removed (Task 2), add a sentence to the surrounding env-table section or the dashboard section:

```markdown
Pre-PR checks (per-repo commands run before push/PR creation) are configured in the dashboard:
**Pre-PR checks** in the cockpit sidebar. Admins and owners can edit; changes are versioned with
one-click restore.
```

- [ ] **Step 3: Update docs/SPEC.md (conditional)**

Only if `grep -q "Pre-PR Checks (optional gate)" docs/SPEC.md` succeeds:
1. Section 6 (Sandbox / limits group): replace `` `PRE_PR_CHECKS` (optional JSON — per-repo commands run as a pre-PR gate, Section 9.3)`` with `` pre-PR check commands are dashboard-managed (Section 9.3), not env config``.
2. Section 9.3: replace the first sentence with: "Pre-PR check commands are configured in the dashboard (cockpit → Pre-PR checks; admin/owner-editable, versioned with rollback, stored in `pre_pr_check_config_versions`). When configured, the workflow runs them inside the sandbox after the phases and before push/PR creation — only for repositories whose HEAD changed since provisioning."
3. Section 18.1: update the pre-PR gate bullet to "- Pre-PR check gate: dashboard-managed per-repo sandbox commands (versioned, with rollback) with agent fix cycles before push/PR creation."
4. Section 4 (tables list): add `- \`pre_pr_check_config_versions\` — append-only dashboard-managed pre-PR check config (current = highest version).`

- [ ] **Step 4: Full verification**

Run from the repo root:

```bash
pnpm --filter worker exec vitest run
pnpm --filter worker typecheck
npx tsc -p apps/dashboard/tsconfig.json --noEmit
cd apps/dashboard && node --test app/api/pre-pr-checks/route.test.ts && cd ../..
grep -rn "PRE_PR_CHECKS" apps/ SETUP.md README.md || echo "env var fully retired"
```

Expected: all suites pass, both typechecks clean, and the final grep prints "env var fully retired" (no matches in code — `docs/superpowers/` history references are fine).

- [ ] **Step 5: Commit**

```bash
git add README.md SETUP.md docs/SPEC.md
git commit -m "Document dashboard-managed pre-PR checks"
```
