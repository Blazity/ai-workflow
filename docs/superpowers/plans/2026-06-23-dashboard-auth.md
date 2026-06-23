# Dashboard Auth (Better Auth, worker as backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a valid human login (predefined credentials, no registration) before any data reaches the dashboard, with the worker as the single auth + data backend.

**Architecture:** The worker (Nitro) hosts Better Auth at `/api/auth/**` over its existing Neon/drizzle DB. The dashboard stays a thin BFF: the browser only talks to the dashboard origin; the worker-issued session token rides in a first-party `httpOnly` cookie (`ba_session`) and is replayed server-side as `Authorization: Bearer <token>` on every worker call. The worker's `/api/v1/**` gate switches from a static shared token (`WORKER_API_TOKEN`, retired) to a valid Better Auth session.

**Tech Stack:** Better Auth `^1.6.20` (`better-auth/adapters/drizzle`, `better-auth/plugins` → `bearer`), Nitro + h3, drizzle-orm + Neon, Next.js 15 App Router, vitest + `@electric-sql/pglite` (worker tests).

## Global Constraints

- **Single dependency:** add `better-auth@^1.6.20` to the **worker only** (`pnpm --filter worker add better-auth@^1.6.20`). The drizzle adapter and bearer plugin are bundled subpaths — do **not** install `@better-auth/drizzle-adapter`. The dashboard gets **no new dependency**.
- **Imports:** worker is ESM with `.js` extension imports (e.g. `from "../env.js"`); use `import type` for type-only imports so they erase at runtime. `@shared/*` → `../shared/*` (path alias, not a package).
- **Password hashing:** Better Auth default **scrypt** (pure-JS). Do **not** configure argon2 or any custom hasher.
- **Session:** rely on Better Auth defaults — `expiresIn` 604800s (7 days), `updateAge` 86400s (1 day, rolling). Do **not** add a `session` config block.
- **Cookie:** name `ba_session`; `httpOnly: true`, `secure: true`, `sameSite: "lax"`, `path: "/"`, `maxAge` 7 days. Set/cleared only in Route Handlers (never during a Server Component render — Next forbids cookie mutation in render).
- **Worker gate scope:** the `/api/v1/**` middleware is the only place session is enforced. `/api/auth/**`, `/webhooks/**` (HMAC), and `/cron/**` keep their existing handling and are **not** session-gated.
- **`WORKER_API_TOKEN` is retired** from both apps, `.env.example`s, `SETUP.md`, and `README.md`.
- **Fail closed:** if auth is misconfigured or the worker is unreachable during session validation, redirect to `/login` — never render the cockpit without a confirmed session. (Non-auth **data** errors still degrade to the existing mock fallback.)

## File Structure

**Worker — new:**
- `apps/worker/src/db/auth-schema.ts` — drizzle tables `user`/`session`/`account`/`verification` (Better Auth core schema).
- `apps/worker/src/auth.ts` — pure, env-free: `createAuth(db, opts)` factory, `seedAuthUser(auth, creds)`, `assertSession(auth, headers)`, exported `Auth` type.
- `apps/worker/src/auth-instance.ts` — the runtime `auth` singleton (`createAuth(getDb(), …env)`). Isolating the env wiring here keeps `auth.ts` importable in unit tests without the worker's full t3-env validation.
- `apps/worker/src/routes/api/auth/[...all].ts` — catch-all delegating to `auth.handler(toWebRequest(event))`.
- `apps/worker/scripts/seed-auth-user.ts` — build-time, env-guarded idempotent seeder.
- `apps/worker/src/auth.test.ts`, `apps/worker/src/routes/api/auth/auth-route.test.ts` — tests.

**Worker — changed:** `package.json` (dep + scripts), `env.ts` (+5 vars, −1), `env.test.ts`, `src/db/schema.ts` (re-export auth tables), `src/middleware/api-auth.ts` (session gate), `src/middleware/api-auth.test.ts` (rewritten), `.env.example`. **Deleted:** `src/lib/api-auth.ts`.

**Dashboard — new:** `lib/auth/errors.ts` (`UnauthorizedError`), `lib/auth/session.ts` (`requireSession`), `middleware.ts`, `app/login/page.tsx`, `app/api/auth/login/route.ts`, `app/api/auth/logout/route.ts`, `components/cockpit/logout-button.tsx`.

**Dashboard — changed:** `lib/api/server.ts` (cookie bearer + 401→`UnauthorizedError` + `authAwareFallback`), the seven `app/*-data.tsx` files + `lib/api/ticket-runs.ts` (auth-aware catches), `app/(cockpit)/layout.tsx` (`requireSession`), `app/(cockpit)/cockpit-shell.tsx` (logout button), `.env.example`.

## Testing approach (deviation from the spec — read this)

The worker has vitest + a pglite DB harness, so **all worker behaviour is covered by automated tests** below.

The **dashboard has no test runner** (no vitest/jest; deps are only `next`/`react`). The spec's "Dashboard unit" bullets assume one. Rather than silently bolt a new toolchain onto the Next app (mocking `next/headers`/`NextRequest` is non-trivial and is scope the spec didn't budget), this plan verifies the dashboard via a **scripted manual smoke test** (Task 11) that exercises login → data → logout → blocked. If you want true dashboard unit tests, that's a separate ~1-task vitest setup — flag it before starting Task 7.

---

### Task 1: Worker — add `better-auth` + new env vars

**Files:**
- Modify: `apps/worker/package.json` (dependencies)
- Modify: `apps/worker/env.ts` (add 5 keys to the `server` object)
- Modify: `apps/worker/env.test.ts:30` (extend the valid-env fixture)
- Modify: `apps/worker/.env.example` (document the new vars)

**Interfaces:**
- Produces: env keys `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DASHBOARD_ORIGIN`, `DASHBOARD_AUTH_EMAIL`, `DASHBOARD_AUTH_PASSWORD` (all required, validated by t3-env). `WORKER_API_TOKEN` is **kept for now** (removed in Task 6 so the app keeps working between tasks).

- [ ] **Step 1: Install the dependency**

Run: `pnpm --filter worker add better-auth@^1.6.20`
Expected: `apps/worker/package.json` gains `"better-auth": "^1.6.20"` under `dependencies`; lockfile updates.

- [ ] **Step 2: Add the new env vars to `env.ts`**

In `apps/worker/env.ts`, inside the `server: { … }` object, add these keys (e.g. directly after the existing `WORKER_API_TOKEN` entry). `runtimeEnv` is `process.env`, so no other change is needed:

```ts
    BETTER_AUTH_SECRET: z.string().min(32, {
      message: "must be at least 32 characters",
    }),
    BETTER_AUTH_URL: z.string().url(),
    DASHBOARD_ORIGIN: z.string().url(),
    DASHBOARD_AUTH_EMAIL: z.string().email(),
    DASHBOARD_AUTH_PASSWORD: z.string().min(8, {
      message: "must be at least 8 characters",
    }),
```

- [ ] **Step 3: Extend the env test fixture**

In `apps/worker/env.test.ts`, find the valid-env object (the one with `WORKER_API_TOKEN: "a".repeat(64),` at ~line 30) and add the new keys to it:

```ts
    WORKER_API_TOKEN: "a".repeat(64),
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "https://worker.example.com",
    DASHBOARD_ORIGIN: "https://dashboard.example.com",
    DASHBOARD_AUTH_EMAIL: "admin@example.com",
    DASHBOARD_AUTH_PASSWORD: "supersecret",
```

- [ ] **Step 4: Document the new vars in `.env.example`**

In `apps/worker/.env.example`, add below the existing `WORKER_API_TOKEN=` block:

```bash
# Better Auth (dashboard human login). The worker is the auth authority.
# BETTER_AUTH_SECRET: signing/encryption key, >= 32 chars. `openssl rand -base64 32`.
BETTER_AUTH_SECRET=
# BETTER_AUTH_URL: the worker's own base URL (no trailing slash).
BETTER_AUTH_URL=https://your-worker.vercel.app
# DASHBOARD_ORIGIN: the dashboard's origin, for Better Auth trustedOrigins.
DASHBOARD_ORIGIN=https://your-dashboard.vercel.app
# The single predefined admin seeded at build time (no registration UI).
DASHBOARD_AUTH_EMAIL=
DASHBOARD_AUTH_PASSWORD=
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter worker test env.test.ts`
Expected: PASS (the fixture still validates with the added keys).
Run: `pnpm --filter worker typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/package.json apps/worker/env.ts apps/worker/env.test.ts apps/worker/.env.example pnpm-lock.yaml
git commit -m "feat(worker): add better-auth dep and auth env vars"
```

---

### Task 2: Worker — Better Auth schema + migration

**Files:**
- Create: `apps/worker/src/db/auth-schema.ts`
- Modify: `apps/worker/src/db/schema.ts` (append a re-export)
- Create (generated): `apps/worker/drizzle/000X_*.sql`

**Interfaces:**
- Produces: drizzle tables `user`, `session`, `account`, `verification` with SQL table names `user`/`session`/`account`/`verification`. JS property keys are camelCase Better Auth field names (the drizzle adapter matches by property key); SQL column names are snake_case (repo convention).

- [ ] **Step 1: Write the auth schema**

Create `apps/worker/src/db/auth-schema.ts`:

```ts
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Better Auth core schema (user / session / account / verification). Property
// keys MUST stay the camelCase Better Auth field names — the drizzle adapter
// resolves columns by key. SQL column names follow the repo's snake_case style.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Re-export the auth tables from the main schema**

Append to `apps/worker/src/db/schema.ts` (so both `getDb()`'s `schema` and `drizzle-kit` see them):

```ts
export * from "./auth-schema.js";
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter worker db:generate`
Expected: a new file `apps/worker/drizzle/0004_*.sql` (next index) appears, containing `CREATE TABLE "user"`, `"session"`, `"account"`, `"verification"`, the `unique` constraints on `user.email` and `session.token`, and the `references`/foreign keys. `meta/_journal.json` updates.

- [ ] **Step 4: Verify the generated SQL and typecheck**

Run: `cat apps/worker/drizzle/0004_*.sql`
Expected: the four `CREATE TABLE` statements with the columns above.
Run: `pnpm --filter worker typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/db/auth-schema.ts apps/worker/src/db/schema.ts apps/worker/drizzle/
git commit -m "feat(worker): add Better Auth drizzle schema + migration"
```

---

### Task 3: Worker — `createAuth` factory, `seedAuthUser`, `assertSession` (+ tests)

**Files:**
- Create: `apps/worker/src/auth.ts`
- Create: `apps/worker/src/auth-instance.ts`
- Create: `apps/worker/src/auth.test.ts`

**Interfaces:**
- Produces:
  - `createAuth(db: Db, options: { secret: string; baseURL: string; trustedOrigins: string[] }): Auth`
  - `type Auth = ReturnType<typeof createAuth>`
  - `seedAuthUser(auth: Auth, creds: { email: string; password: string; name?: string }): Promise<{ created: boolean; updated: boolean }>`
  - `assertSession(auth: Auth, headers: Headers): Promise<void>` (throws h3 `createError` 401 when no session)
  - `auth` singleton exported from `auth-instance.ts`
- Consumes: `Db` from `./db/client.js` (type-only); `getDb`, `env` (in `auth-instance.ts` only); `createTestDb` from `./db/test-db.js` (tests).

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTestDb } from "./db/test-db.js";
import { createAuth, seedAuthUser, type Auth } from "./auth.js";

const OPTS = {
  secret: "x".repeat(32),
  baseURL: "http://localhost:3000",
  trustedOrigins: ["http://localhost:3001"],
};

async function freshAuth(): Promise<Auth> {
  return createAuth(await createTestDb(), OPTS);
}

function tokenFrom(res: { headers: Headers; response: unknown }): string {
  return (
    res.headers.get("set-auth-token") ??
    (res.response as { token?: string }).token ??
    ""
  );
}

describe("seedAuthUser", () => {
  it("creates the user when absent", async () => {
    const auth = await freshAuth();
    const r = await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    expect(r).toEqual({ created: true, updated: false });
  });

  it("is idempotent — no duplicate, no change on re-run", async () => {
    const auth = await freshAuth();
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const r = await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    expect(r).toEqual({ created: false, updated: false });
    const ctx = await auth.$context;
    const found = await ctx.internalAdapter.findUserByEmail("admin@x.com");
    expect(found).not.toBeNull();
  });

  it("re-hashes when the password changes", async () => {
    const auth = await freshAuth();
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const r = await seedAuthUser(auth, { email: "admin@x.com", password: "newpassword456" });
    expect(r).toEqual({ created: false, updated: true });

    await expect(
      auth.api.signInEmail({ body: { email: "admin@x.com", password: "password123" } }),
    ).rejects.toThrow();

    const ok = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "newpassword456" },
      returnHeaders: true,
    });
    expect(tokenFrom(ok)).toBeTruthy();
  });
});

describe("bearer round-trip", () => {
  it("accepts a valid bearer and rejects bad/missing", async () => {
    const auth = await freshAuth();
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const signIn = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "password123" },
      returnHeaders: true,
    });
    const token = tokenFrom(signIn);
    expect(token).toBeTruthy();

    const good = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(good?.user.email).toBe("admin@x.com");

    const bad = await auth.api.getSession({
      headers: new Headers({ authorization: "Bearer nope" }),
    });
    expect(bad).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter worker test src/auth.test.ts`
Expected: FAIL — `Cannot find module './auth.js'`.

- [ ] **Step 3: Write `auth.ts`**

Create `apps/worker/src/auth.ts`:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { createError } from "h3";

import type { Db } from "./db/client.js";

export type AuthOptions = {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
};

/**
 * Build a Better Auth instance over an existing drizzle/Neon db. Pure and
 * env-free so it can be unit-tested against a pglite db. emailAndPassword is
 * enabled but sign-up is disabled (single predefined admin, no registration);
 * the bearer plugin lets the dashboard replay the session token as a Bearer.
 */
export function createAuth(db: Db, options: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [bearer()],
    trustedOrigins: options.trustedOrigins,
    secret: options.secret,
    baseURL: options.baseURL,
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Idempotently ensure the single predefined admin exists with the given
 * password. Uses Better Auth's own context (scrypt hashing + credential
 * account linking) so the seeded login matches the sign-in path exactly.
 * Creates when absent; re-hashes only when the password no longer verifies.
 */
export async function seedAuthUser(
  auth: Auth,
  creds: { email: string; password: string; name?: string },
): Promise<{ created: boolean; updated: boolean }> {
  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(creds.email, {
    includeAccounts: true,
  });

  if (!existing) {
    const hash = await ctx.password.hash(creds.password);
    const created = await ctx.internalAdapter.createUser({
      email: creds.email,
      name: creds.name ?? creds.email,
      emailVerified: true,
    });
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: hash,
    });
    return { created: true, updated: false };
  }

  const credential = existing.accounts.find((a) => a.providerId === "credential");
  const matches =
    credential?.password != null
      ? await ctx.password.verify({ hash: credential.password, password: creds.password })
      : false;

  if (!matches) {
    const hash = await ctx.password.hash(creds.password);
    await ctx.internalAdapter.updatePassword(existing.user.id, hash);
    return { created: false, updated: true };
  }

  return { created: false, updated: false };
}

/**
 * Throw a 401 unless the request carries a valid Better Auth session
 * (`Authorization: Bearer <session-token>`, via the bearer plugin).
 */
export async function assertSession(auth: Auth, headers: Headers): Promise<void> {
  const session = await auth.api.getSession({ headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }
}
```

- [ ] **Step 4: Write the runtime singleton**

Create `apps/worker/src/auth-instance.ts`:

```ts
import { env } from "../env.js";
import { createAuth } from "./auth.js";
import { getDb } from "./db/client.js";

/** The worker's Better Auth instance, wired from validated env. */
export const auth = createAuth(getDb(), {
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.DASHBOARD_ORIGIN],
});
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `pnpm --filter worker test src/auth.test.ts`
Expected: PASS (all 5 tests). This proves the hand-written schema, the drizzle adapter, scrypt hashing, the seed, and bearer-token validation all line up.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter worker typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/auth.ts apps/worker/src/auth-instance.ts apps/worker/src/auth.test.ts
git commit -m "feat(worker): add Better Auth factory, seed and session helpers"
```

---

### Task 4: Worker — build-time user seeder

**Files:**
- Create: `apps/worker/scripts/seed-auth-user.ts`
- Modify: `apps/worker/package.json` (`scripts`)

**Interfaces:**
- Consumes: `createAuth`, `seedAuthUser` (`src/auth.ts`); `process.env`.
- Produces: `pnpm --filter worker seed:auth-user`; runs in `build` after `db:migrate`.

- [ ] **Step 1: Write the seeder script**

Create `apps/worker/scripts/seed-auth-user.ts`. It reads `process.env` and **skips cleanly** when env is missing (so local `pnpm build` still works), then dynamically imports the auth modules so a missing env never triggers the worker's t3-env validation:

```ts
/**
 * Build-time admin seeder. Runs after `db:migrate` in `pnpm build`, where
 * Vercel injects the env. Idempotent (see seedAuthUser). Locally, with env
 * missing, it warn-and-skips so `pnpm build` still works without secrets.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const {
  DATABASE_URL,
  BETTER_AUTH_SECRET,
  BETTER_AUTH_URL,
  DASHBOARD_ORIGIN,
  DASHBOARD_AUTH_EMAIL,
  DASHBOARD_AUTH_PASSWORD,
} = process.env;

if (
  !DATABASE_URL ||
  !BETTER_AUTH_SECRET ||
  !DASHBOARD_AUTH_EMAIL ||
  !DASHBOARD_AUTH_PASSWORD
) {
  console.warn("[seed-auth-user] missing env — skipping.");
  process.exit(0);
}

const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");
const schema = await import("../src/db/schema.js");
const { createAuth, seedAuthUser } = await import("../src/auth.js");
const type = await import("../src/db/client.js"); // for the Db type at runtime is unused; cast below
void type;

const db = drizzle({ client: neon(DATABASE_URL), schema }) as unknown as Parameters<
  typeof createAuth
>[0];

const auth = createAuth(db, {
  secret: BETTER_AUTH_SECRET,
  baseURL: BETTER_AUTH_URL ?? "http://localhost:3000",
  trustedOrigins: DASHBOARD_ORIGIN ? [DASHBOARD_ORIGIN] : [],
});

const r = await seedAuthUser(auth, {
  email: DASHBOARD_AUTH_EMAIL,
  password: DASHBOARD_AUTH_PASSWORD,
});
console.log(
  `[seed-auth-user] ${r.created ? "created" : r.updated ? "updated password" : "unchanged"}.`,
);
```

> Note: the `db` is built the same way as `getDb()` (neon-http + the full schema) rather than importing `getDb()`, because `getDb()` pulls in `env.ts` and its full validation — which would defeat the warn-and-skip. The `Parameters<typeof createAuth>[0]` cast mirrors the existing `as unknown as Db` cast in `src/db/test-db.ts`.

- [ ] **Step 2: Add the scripts**

In `apps/worker/package.json`, add to `scripts`:

```json
    "seed:auth-user": "tsx scripts/seed-auth-user.ts",
```

and update `build` to run it after `db:migrate`:

```json
    "build": "pnpm validate:pre-sandbox && pnpm db:migrate && pnpm seed:auth-user && rm -rf .nitro/workflow && NODE_OPTIONS=--max-old-space-size=8192 nitro build",
```

- [ ] **Step 3: Verify the skip path (no DB env locally)**

Run: `env -u DATABASE_URL pnpm --filter worker seed:auth-user`
Expected: prints `[seed-auth-user] missing env — skipping.` and exits 0.

- [ ] **Step 4: Verify the seed path against a real DB (optional, if you have a dev `DATABASE_URL` + the auth env in `apps/worker/.env.local`)**

Run: `pnpm --filter worker db:migrate && pnpm --filter worker seed:auth-user`
Expected: `[seed-auth-user] created.` on first run, `unchanged.` on the second.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/scripts/seed-auth-user.ts apps/worker/package.json
git commit -m "feat(worker): seed predefined admin at build time"
```

---

### Task 5: Worker — Better Auth catch-all route

**Files:**
- Create: `apps/worker/src/routes/api/auth/[...all].ts`
- Create: `apps/worker/src/routes/api/auth/auth-route.test.ts`

**Interfaces:**
- Consumes: `auth` (`src/auth-instance.ts`); `toWebRequest`, `defineEventHandler` (h3).
- Produces: every `/api/auth/**` request (any method) handled by Better Auth.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/routes/api/auth/auth-route.test.ts` (tests the exact h3→Web adaptation against a pglite auth, without importing the env-bound singleton):

```ts
import { describe, it, expect } from "vitest";
import { createApp, eventHandler, toWebHandler, toWebRequest } from "h3";
import { createTestDb } from "../../../db/test-db.js";
import { createAuth } from "../../../auth.js";

describe("auth catch-all", () => {
  it("delegates /api/auth/* to the Better Auth handler", async () => {
    const auth = createAuth(await createTestDb(), {
      secret: "x".repeat(32),
      baseURL: "http://localhost",
      trustedOrigins: ["http://localhost:3001"],
    });
    const app = createApp();
    app.use(eventHandler((event) => auth.handler(toWebRequest(event))));
    const handler = toWebHandler(app);

    const res = await handler(
      new Request("http://localhost/api/auth/get-session"),
    );
    // Better Auth handled the route (200 with a null body when unauthenticated),
    // i.e. it is NOT a 404 from the router.
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter worker test src/routes/api/auth/auth-route.test.ts`
Expected: FAIL (route file does not exist yet → the test file's relative imports of `createAuth` resolve, but create the route to mirror production; if this test already passes because it only exercises `createAuth`, that's fine — the route file in Step 3 is what ships).

> The test deliberately exercises the same `auth.handler(toWebRequest(event))` adaptation the route uses, with an injectable pglite auth. The shipped route (Step 3) uses the env-bound singleton.

- [ ] **Step 3: Write the route**

Create `apps/worker/src/routes/api/auth/[...all].ts`:

```ts
import { defineEventHandler, toWebRequest } from "h3";

import { auth } from "../../../auth-instance.js";

// Better Auth owns every method under /api/auth/** (sign-in, sign-out,
// get-session, …). Nitro/h3 speaks Web Request/Response, so we just adapt the
// event and hand off. This path is intentionally NOT session-gated.
export default defineEventHandler((event) => auth.handler(toWebRequest(event)));
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter worker test src/routes/api/auth/auth-route.test.ts`
Expected: PASS (status 200).
Run: `pnpm --filter worker typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/routes/api/auth/
git commit -m "feat(worker): mount Better Auth handler at /api/auth/**"
```

---

### Task 6: Worker — switch the `/api/v1/**` gate to a valid session

**Files:**
- Modify: `apps/worker/src/middleware/api-auth.ts` (replace body)
- Replace: `apps/worker/src/middleware/api-auth.test.ts` (rewrite)
- Delete: `apps/worker/src/lib/api-auth.ts`
- Modify: `apps/worker/env.ts` (remove `WORKER_API_TOKEN`)
- Modify: `apps/worker/env.test.ts` (remove `WORKER_API_TOKEN` from fixture)
- Modify: `apps/worker/.env.example` (remove the `WORKER_API_TOKEN` block)

**Interfaces:**
- Consumes: `assertSession`, `auth` (Task 3); `toWebRequest` (h3).
- Produces: `/api/v1/**` returns 401 without a valid session, 200 with one. `verifyApiToken`/`WORKER_API_TOKEN` no longer exist in the worker.

- [ ] **Step 1: Rewrite the middleware test**

Replace the contents of `apps/worker/src/middleware/api-auth.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { createTestDb } from "../db/test-db.js";
import { createAuth, seedAuthUser, assertSession, type Auth } from "../auth.js";

async function authWithUser(): Promise<Auth> {
  const auth = createAuth(await createTestDb(), {
    secret: "x".repeat(32),
    baseURL: "http://localhost",
    trustedOrigins: ["http://localhost:3001"],
  });
  await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
  return auth;
}

describe("assertSession (the /api/v1 gate)", () => {
  it("passes for a valid session bearer", async () => {
    const auth = await authWithUser();
    const signIn = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "password123" },
      returnHeaders: true,
    });
    const token =
      signIn.headers.get("set-auth-token") ??
      (signIn.response as { token?: string }).token ??
      "";
    await expect(
      assertSession(auth, new Headers({ authorization: `Bearer ${token}` })),
    ).resolves.toBeUndefined();
  });

  it("throws 401 when the bearer is missing or invalid", async () => {
    const auth = await authWithUser();
    await expect(assertSession(auth, new Headers())).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(
      assertSession(auth, new Headers({ authorization: "Bearer nope" })),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter worker test src/middleware/api-auth.test.ts`
Expected: FAIL — the old middleware still imports `verifyApiToken`; the new test imports helpers that exist, but the assertion against the gate hasn't been wired. (If the test already passes because `assertSession` exists from Task 3, proceed — the production swap in Step 3 is the real change.)

- [ ] **Step 3: Rewrite the middleware**

Replace the contents of `apps/worker/src/middleware/api-auth.ts` with:

```ts
import { defineEventHandler, toWebRequest } from "h3";

import { auth } from "../auth-instance.js";
import { assertSession } from "../auth.js";

/**
 * Gate the read-only `/api/v1/*` observability API behind a valid Better Auth
 * session. The dashboard replays its httpOnly session cookie as
 * `Authorization: Bearer <token>` on every server-side worker call; a request
 * without a valid session is rejected with 401.
 *
 * Only `/api/v1/*` is gated — `/api/auth/*` (the auth handler), webhooks
 * (`/webhooks/*`, HMAC-signed) and the cron entrypoint (`/cron/*`) keep their
 * own handling.
 */
export default defineEventHandler(async (event) => {
  if (!event.path.startsWith("/api/v1/")) return;
  await assertSession(auth, toWebRequest(event).headers);
});
```

- [ ] **Step 4: Delete the dead token helper**

Run: `git rm apps/worker/src/lib/api-auth.ts`
Expected: file removed. (It was only used by the middleware.)

- [ ] **Step 5: Remove `WORKER_API_TOKEN` from env**

In `apps/worker/env.ts`, delete the `WORKER_API_TOKEN: z.string().regex(...)` entry.
In `apps/worker/env.test.ts`, delete the `WORKER_API_TOKEN: "a".repeat(64),` line from the fixture.
In `apps/worker/.env.example`, delete the `WORKER_API_TOKEN` comment block + `WORKER_API_TOKEN=` line (the dashboard-API section).

- [ ] **Step 6: Run the full worker test suite + typecheck**

Run: `pnpm --filter worker test`
Expected: PASS (no references to `verifyApiToken`/`WORKER_API_TOKEN` remain; the new gate test passes).
Run: `pnpm --filter worker typecheck`
Expected: PASS.
Run: `grep -rn "WORKER_API_TOKEN" apps/worker`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/middleware/api-auth.ts apps/worker/src/middleware/api-auth.test.ts apps/worker/env.ts apps/worker/env.test.ts apps/worker/.env.example
git rm apps/worker/src/lib/api-auth.ts
git commit -m "feat(worker): gate /api/v1 on a valid session, retire WORKER_API_TOKEN"
```

---

### Task 7: Dashboard — bearer cookie + typed 401 in `getJSON`

**Files:**
- Create: `apps/dashboard/lib/auth/errors.ts`
- Modify: `apps/dashboard/lib/api/server.ts`
- Modify: `apps/dashboard/app/runs-data.tsx`, `prompts-data.tsx`, `cost-data.tsx`, `overview-data.tsx`, `trace-data.tsx`, `evals-data.tsx`
- Modify: `apps/dashboard/lib/api/ticket-runs.ts`
- Modify: `apps/dashboard/.env.example`

**Interfaces:**
- Produces: `class UnauthorizedError extends Error`; `getJSON` now reads the `ba_session` cookie, sends it as a Bearer, and throws `UnauthorizedError` on 401; `authAwareFallback(err, fallback)` redirects to `/login` on `UnauthorizedError`, else returns the fallback.
- Consumes: `cookies` (`next/headers`), `redirect` (`next/navigation`).

- [ ] **Step 1: Define the error type**

Create `apps/dashboard/lib/auth/errors.ts`:

```ts
/** Thrown by getJSON when the worker rejects the session (HTTP 401). */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
```

- [ ] **Step 2: Rewrite `lib/api/server.ts`**

Replace the contents of `apps/dashboard/lib/api/server.ts` with (keeps `withQuery` unchanged; swaps the static token for the cookie; adds the 401 path + `authAwareFallback`):

```ts
// apps/dashboard/lib/api/server.ts
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { UnauthorizedError } from "@/lib/auth/errors";

const BASE = process.env.WORKER_BASE_URL ?? "";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Server-only JSON fetch. Runs on the Next server (never the browser), so no
 * CORS and no NEXT_PUBLIC_ exposure. `no-store` => fresh on every full page load.
 *
 * Replays the human session: reads the first-party `ba_session` cookie and
 * sends it to the worker as `Authorization: Bearer <token>`. The worker
 * validates the session and serves data. A 401 becomes a typed
 * `UnauthorizedError` so callers can redirect to /login instead of masking it
 * with a mock fallback (see authAwareFallback).
 */
/** Append a query string, skipping empty/undefined values. */
export function withQuery(
  path: string,
  params: Record<string, string | null | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function getJSON<T>(path: string): Promise<T> {
  const token = (await cookies()).get("ba_session")?.value;
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401) {
    throw new UnauthorizedError(`GET ${path} → 401`);
  }
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Use in a server component's `.catch` so non-auth failures degrade to the
 * existing mock fallback, but a 401 redirects to /login instead of silently
 * showing mock data. `redirect()` throws NEXT_REDIRECT, which Next handles
 * server-side (do not wrap this in another try/catch).
 */
export function authAwareFallback<T>(err: unknown, fallback: () => T): T {
  if (err instanceof UnauthorizedError) {
    redirect("/login");
  }
  return fallback();
}
```

- [ ] **Step 3: Make each data file's catch auth-aware**

In every server-component data file, import `authAwareFallback` from `@/lib/api/server` (next to the existing `getJSON` import) and change each `.catch(() => FB)` to `.catch((e) => authAwareFallback(e, () => FB))`. Exact edits:

**`apps/dashboard/app/runs-data.tsx`** — import line becomes `import { getJSON, withQuery, authAwareFallback } from "@/lib/api/server";`, then:
```tsx
    getJSON<RunsResponse>(withQuery("/api/v1/runs", { window, q })).catch((e) =>
      authAwareFallback(e, () => recentRunsFallback(now)),
    ),
    getJSON<LiveRunsResponse>("/api/v1/runs/live").catch((e) =>
      authAwareFallback(e, () => liveRunsFallback(now)),
    ),
```

**`apps/dashboard/app/prompts-data.tsx`** — import `authAwareFallback`, then:
```tsx
  const data = await getJSON<PromptsResponse>("/api/v1/prompts").catch((e) =>
    authAwareFallback(e, () => promptsFallback(now)),
  );
```

**`apps/dashboard/app/cost-data.tsx`** — import `authAwareFallback`, then:
```tsx
  const data = await getJSON<CostResponse>(
    withQuery("/api/v1/cost", { window }),
  ).catch((e) => authAwareFallback(e, () => costFallback(now)));
```

**`apps/dashboard/app/overview-data.tsx`** — import `authAwareFallback`, then change all five catches:
```tsx
    getJSON<KpisResponse>(withQuery("/api/v1/overview/kpis", { window })).catch(
      (e) => authAwareFallback(e, () => kpisFallback(now)),
    ),
    getJSON<EvalHealthResponse>("/api/v1/overview/eval-health").catch((e) =>
      authAwareFallback(e, () => evalHealthFallback()),
    ),
    getJSON<RunsResponse>(withQuery("/api/v1/runs", { window })).catch((e) =>
      authAwareFallback(e, () => recentRunsFallback(now)),
    ),
    getJSON<LiveRunsResponse>("/api/v1/runs/live").catch((e) =>
      authAwareFallback(e, () => liveRunsFallback(now)),
    ),
    getJSON<WorkflowsResponse>(withQuery("/api/v1/workflows", { window })).catch(
      (e) => authAwareFallback(e, () => workflowsFallback(now)),
    ),
```

**`apps/dashboard/app/trace-data.tsx`** — import `authAwareFallback`, then:
```tsx
  const data = await getJSON<RunDetailResponse>(
    `/api/v1/runs/${encodeURIComponent(runId)}`,
  ).catch((e) => authAwareFallback(e, () => runDetailFallback(now)));
```

**`apps/dashboard/app/evals-data.tsx`** — import `authAwareFallback`, then:
```tsx
  const data = await getJSON<EvalsResponse>("/api/v1/evals").catch((e) =>
    authAwareFallback(e, () => evalsFallback(now)),
  );
```

**`apps/dashboard/lib/api/ticket-runs.ts`** — add `authAwareFallback` to the `import { getJSON } from "./server"` line (→ `import { getJSON, authAwareFallback } from "./server";`), then both catches:
```ts
      getJSON<TicketRunsResponse>(
        `/api/v1/tickets/${encodeURIComponent(ticketKey)}`,
      ).catch((e) => authAwareFallback(e, () => ticketRunsFallback(now))),
      getJSON<LiveRunsResponse>("/api/v1/runs/live").catch((e) =>
        authAwareFallback(e, () => liveRunsFallback(now)),
      ),
```
and:
```ts
    return getJSON<RunDetailResponse>(
      `/api/v1/runs/${encodeURIComponent(runId)}`,
    ).catch((e) => authAwareFallback(e, () => runDetailFallback(now)));
```

> Leave the proxy routes `app/api/runs/search/route.ts` and `app/api/prompts/[name]/versions/[version]/route.ts` **unchanged**. They call `getJSON`, which now requires the cookie; an unauthenticated browser yields `UnauthorizedError` → their existing `catch` returns the empty/`available:false` shape. Returning empty (not redirecting) is the correct behaviour for an API route, and no worker data leaks.

- [ ] **Step 4: Remove `WORKER_API_TOKEN` from the dashboard `.env.example`**

In `apps/dashboard/.env.example`, delete the `WORKER_API_TOKEN` comment block + `WORKER_API_TOKEN=` line. Leave `WORKER_BASE_URL`. Add a one-line note that no shared secret is needed:

```bash
# Base URL of the deployed worker (no trailing slash).
# Local dev against a local worker: http://localhost:3000
WORKER_BASE_URL=https://your-worker.vercel.app

# No shared secret here: the dashboard stores the worker-issued human session
# token in a first-party httpOnly cookie (ba_session) and replays it server-side.
```

- [ ] **Step 5: Verify the build compiles**

Run: `pnpm --filter ai-workflow-dashboard build`
Expected: build succeeds (type errors would surface here, since the dashboard has no separate typecheck script).
Run: `grep -rn "WORKER_API_TOKEN" apps/dashboard`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/lib/auth/errors.ts apps/dashboard/lib/api/server.ts apps/dashboard/app/*-data.tsx apps/dashboard/lib/api/ticket-runs.ts apps/dashboard/.env.example
git commit -m "feat(dashboard): send session bearer, surface 401 as UnauthorizedError"
```

---

### Task 8: Dashboard — `requireSession()` gate in the cockpit layout

**Files:**
- Create: `apps/dashboard/lib/auth/session.ts`
- Modify: `apps/dashboard/app/(cockpit)/layout.tsx`

**Interfaces:**
- Produces: `requireSession(): Promise<void>` — reads `ba_session`, validates against the worker's `/api/auth/get-session`; missing/invalid/unreachable → `redirect("/login")`.
- Consumes: `cookies` (`next/headers`), `redirect` (`next/navigation`).

- [ ] **Step 1: Write the session gate**

Create `apps/dashboard/lib/auth/session.ts`:

```ts
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const BASE = process.env.WORKER_BASE_URL ?? "";

/**
 * Server-side gate for the cockpit. Reads the ba_session cookie and validates
 * it against the worker. Missing, invalid, OR unverifiable (worker down) →
 * redirect to /login. One round-trip in the cockpit layout gates every page.
 *
 * Fails closed: we never render the cockpit on a session we couldn't confirm.
 * (Note: we do NOT clear the cookie here — cookie mutation is illegal during a
 * Server Component render. A stale cookie is overwritten at next login, or
 * cleared by the explicit logout route.)
 */
export async function requireSession(): Promise<void> {
  const token = (await cookies()).get("ba_session")?.value;
  if (!token) redirect("/login");

  let valid = false;
  try {
    const res = await fetch(`${BASE}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    // Better Auth returns 200 with a null body when the token is invalid.
    valid = res.ok && (await res.json()) !== null;
  } catch {
    valid = false;
  }
  if (!valid) redirect("/login");
}
```

- [ ] **Step 2: Wire it into the cockpit layout**

Replace the contents of `apps/dashboard/app/(cockpit)/layout.tsx` with:

```tsx
// apps/dashboard/app/(cockpit)/layout.tsx
import { CockpitShell } from "./cockpit-shell";
import { requireSession } from "@/lib/auth/session";

export default async function CockpitLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();
  return <CockpitShell>{children}</CockpitShell>;
}
```

- [ ] **Step 3: Verify the build compiles**

Run: `pnpm --filter ai-workflow-dashboard build`
Expected: build succeeds. (End-to-end behaviour is verified in Task 11; login/logout routes land in Tasks 9–10.)

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/lib/auth/session.ts "apps/dashboard/app/(cockpit)/layout.tsx"
git commit -m "feat(dashboard): validate session in the cockpit layout"
```

---

### Task 9: Dashboard — login page, login route, middleware

**Files:**
- Create: `apps/dashboard/app/api/auth/login/route.ts`
- Create: `apps/dashboard/app/login/page.tsx`
- Create: `apps/dashboard/middleware.ts`

**Interfaces:**
- Consumes: worker `POST /api/auth/sign-in/email`; `cookies` (`next/headers`).
- Produces: `POST /api/auth/login` (sets `ba_session`); `/login` page; edge middleware redirecting cookieless page navigations to `/login`.

- [ ] **Step 1: Write the login route**

Create `apps/dashboard/app/api/auth/login/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const BASE = process.env.WORKER_BASE_URL ?? "";
const SEVEN_DAYS = 60 * 60 * 24 * 7;

export async function POST(req: Request) {
  const { email, password } = (await req.json()) as {
    email?: string;
    password?: string;
  };
  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password required" },
      { status: 400 },
    );
  }

  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const body = (await res.json().catch(() => ({}))) as { token?: string };
  const token = res.headers.get("set-auth-token") ?? body.token;
  if (!token) {
    return NextResponse.json({ error: "Auth misconfigured" }, { status: 502 });
  }

  (await cookies()).set("ba_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SEVEN_DAYS,
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Write the login page**

Create `apps/dashboard/app/login/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setPending(false);
    if (res.ok) {
      router.replace("/");
      router.refresh();
    } else {
      setError("Invalid credentials");
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-app-bg">
      <form
        onSubmit={onSubmit}
        className="w-[320px] flex flex-col gap-3 border border-neutral-200 bg-panel p-6"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          AI Workflow — sign in
        </span>
        <input
          type="email"
          required
          autoFocus
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border border-neutral-300 px-3 py-2 text-[13px]"
        />
        <input
          type="password"
          required
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border border-neutral-300 px-3 py-2 text-[13px]"
        />
        {error ? (
          <span className="text-[12px] text-red-600">{error}</span>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="bg-neutral-900 px-3 py-2 text-[13px] text-white disabled:opacity-50"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
```

> The Tailwind classes (`bg-app-bg`, `bg-panel`) match those already used in `cockpit-shell.tsx`. Adjust only if your design system differs.

- [ ] **Step 3: Write the middleware (presence gate)**

Create `apps/dashboard/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";

/**
 * Cheap presence check: any page navigation without a ba_session cookie is
 * redirected to /login. Real validation happens server-side in the cockpit
 * layout (requireSession). API routes (/api/**), /login, and Next internals
 * are excluded — /api proxies are gated by getJSON's cookie requirement.
 */
export function middleware(req: NextRequest) {
  if (req.cookies.has("ba_session")) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|login).*)"],
};
```

- [ ] **Step 4: Verify the build compiles**

Run: `pnpm --filter ai-workflow-dashboard build`
Expected: build succeeds; `middleware` is detected.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/app/api/auth/login/route.ts apps/dashboard/app/login/page.tsx apps/dashboard/middleware.ts
git commit -m "feat(dashboard): login page, login route, and auth middleware"
```

---

### Task 10: Dashboard — logout route + button

**Files:**
- Create: `apps/dashboard/app/api/auth/logout/route.ts`
- Create: `apps/dashboard/components/cockpit/logout-button.tsx`
- Modify: `apps/dashboard/app/(cockpit)/cockpit-shell.tsx` (top bar)

**Interfaces:**
- Consumes: worker `POST /api/auth/sign-out`; `cookies` (`next/headers`).
- Produces: `POST /api/auth/logout` (worker sign-out + clears `ba_session`); a "Sign out" button in the desktop top bar.

- [ ] **Step 1: Write the logout route**

Create `apps/dashboard/app/api/auth/logout/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const BASE = process.env.WORKER_BASE_URL ?? "";

export async function POST() {
  const jar = await cookies();
  const token = jar.get("ba_session")?.value;
  if (token) {
    await fetch(`${BASE}/api/auth/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {
      // Best-effort worker sign-out; we clear the cookie regardless.
    });
  }
  jar.delete("ba_session");
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Write the logout button**

Create `apps/dashboard/components/cockpit/logout-button.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.replace("/login");
        router.refresh();
      }}
      className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500 hover:text-neutral-800"
    >
      Sign out
    </button>
  );
}
```

- [ ] **Step 3: Add the button to the cockpit top bar**

In `apps/dashboard/app/(cockpit)/cockpit-shell.tsx`, add the import near the other component imports:

```tsx
import { LogoutButton } from "@/components/cockpit/logout-button";
```

Then, in the desktop top bar, replace the lone `<LivePollControl />` with a grouped pair. Find:

```tsx
          <div className="hidden lg:flex items-center justify-between flex-[0_0_44px] h-11 border-b border-neutral-200 bg-panel px-6">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
              {TITLE_FOR_SCREEN[screen] ?? "AI Workflow"}
            </span>
            <LivePollControl />
          </div>
```

and change the last child to:

```tsx
            <div className="flex items-center gap-4">
              <LivePollControl />
              <LogoutButton />
            </div>
```

- [ ] **Step 4: Verify the build compiles**

Run: `pnpm --filter ai-workflow-dashboard build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/app/api/auth/logout/route.ts apps/dashboard/components/cockpit/logout-button.tsx "apps/dashboard/app/(cockpit)/cockpit-shell.tsx"
git commit -m "feat(dashboard): logout route and sign-out button"
```

---

### Task 11: Docs cleanup + end-to-end smoke test

**Files:**
- Modify: `SETUP.md`
- Modify: `README.md`

**Interfaces:** none (docs + manual verification).

- [ ] **Step 1: Update `SETUP.md` — worker env table**

Remove the `WORKER_API_TOKEN` row (~line 262). Add rows for the new worker vars in the same table:

```markdown
| `BETTER_AUTH_SECRET` | Signing/encryption key for Better Auth (dashboard human login). At least 32 chars. Generate: `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | The worker's own base URL (no trailing slash) — Better Auth's `baseURL`. |
| `DASHBOARD_ORIGIN` | The dashboard deployment's origin, added to Better Auth `trustedOrigins`. |
| `DASHBOARD_AUTH_EMAIL` | Email of the single predefined dashboard admin (seeded at build; no registration UI). |
| `DASHBOARD_AUTH_PASSWORD` | Password for that admin. Changing it re-hashes on the next deploy. |
```

- [ ] **Step 2: Update `SETUP.md` — dashboard section (~lines 441–457)**

Remove the `WORKER_API_TOKEN` table row, the `vercel env add WORKER_API_TOKEN production` line, and the trailing paragraph about the shared token. Replace the env table with just `WORKER_BASE_URL`, and replace the closing paragraph with:

```markdown
The dashboard holds no worker secret. Human login is handled by the worker (Better Auth); the dashboard stores the worker-issued session token in a first-party `httpOnly` cookie and replays it server-side. Set `DASHBOARD_ORIGIN` on the **worker** to this dashboard's URL so Better Auth trusts it. Sign in at `/login` with `DASHBOARD_AUTH_EMAIL` / `DASHBOARD_AUTH_PASSWORD`.
```

- [ ] **Step 3: Update `README.md` (~lines 29–31)**

Rewrite the "dashboard talks to the worker" bullet to drop `WORKER_API_TOKEN`:

```markdown
- **The dashboard talks to the worker over HTTP.** The worker exposes a read-only API under `/api/v1/*` (`apps/worker/src/routes/api/v1/`), gated by [`apps/worker/src/middleware/api-auth.ts`](./apps/worker/src/middleware/api-auth.ts) on a valid **Better Auth session**. Human login lives on the worker (`/api/auth/**`, `apps/worker/src/auth.ts`); the dashboard is a thin BFF that stores the worker-issued session token in a first-party `httpOnly` cookie and replays it as `Authorization: Bearer <token>` on every server-side call, so the token never reaches the browser. The two apps deploy as **separate Vercel projects** and share only the `@shared/contracts` types.
```

- [ ] **Step 4: Final repo-wide check**

Run: `grep -rn "WORKER_API_TOKEN" . --exclude-dir=node_modules --exclude-dir=.git`
Expected: only matches inside `docs/superpowers/` (the spec/plan history). No code, env, or doc references remain.

- [ ] **Step 5: Manual end-to-end smoke test**

Set `apps/worker/.env.local` (DATABASE_URL + the 5 new auth vars + the rest of the worker env) and `apps/dashboard/.env.local` (`WORKER_BASE_URL=http://localhost:3000`). Seed + run:

1. `pnpm --filter worker db:migrate && pnpm --filter worker seed:auth-user` → expect `created.`
2. Terminal A: `pnpm --filter worker dev` (worker on :3000). Terminal B: `pnpm --filter ai-workflow-dashboard dev` (dashboard on :3001).
3. Visit `http://localhost:3001/` → **redirected to `/login`** (no cookie).
4. Submit a **wrong** password → "Invalid credentials"; still on `/login`.
5. Submit the seeded `DASHBOARD_AUTH_EMAIL` / `DASHBOARD_AUTH_PASSWORD` → redirected to `/`, cockpit renders with **real** data (not N/A mock tiles).
6. Hard-reload `/runs`, `/cost`, `/prompts` → all load with data (session cookie replayed).
7. Click **Sign out** → redirected to `/login`; visiting `/` again → back to `/login`.
8. Confirm direct worker access is gated: `curl -i http://localhost:3000/api/v1/runs` → **401**.

Expected: every assertion holds. (This is independent of the orchestration e2e, which can't run locally.)

- [ ] **Step 6: Commit**

```bash
git add SETUP.md README.md
git commit -m "docs: retire WORKER_API_TOKEN, document Better Auth dashboard login"
```

---

## Self-Review

**Spec coverage:**
- Worker `src/auth.ts` (betterAuth + drizzle adapter + `disableSignUp` + `bearer()` + `trustedOrigins` + secret/baseURL + scrypt) → Task 3 (`createAuth`) + Task 3 (`auth-instance.ts` wiring). ✓
- Worker catch-all `/api/auth/[...all]` → Task 5. ✓
- Better Auth schema + migration → Task 2. ✓ (hand-written drizzle file backed by the round-trip test in Task 3, instead of the CLI generator — see note below).
- `scripts/seed-auth-user.ts`, runs in build after migrate, idempotent + re-hash → Task 4 (script + build wiring) + Task 3 (`seedAuthUser` + its tests). ✓
- Worker middleware → valid session, retire `WORKER_API_TOKEN`, delete `lib/api-auth.ts` → Task 6. ✓
- Dashboard `middleware.ts` → Task 9. ✓
- `app/login` + login route sets `ba_session` → Task 9. ✓
- Logout route → Task 10. ✓
- `requireSession()` in cockpit layout → Task 8. ✓
- `getJSON` bearer + `UnauthorizedError`, `WORKER_API_TOKEN` removed → Task 7. ✓
- Error handling: wrong creds (login route 401 → "Invalid credentials"), expired mid-use (`UnauthorizedError` → `authAwareFallback` → `/login`; non-auth errors keep mock fallback), fail-closed (`requireSession`) → Tasks 7, 8, 9. ✓
- Env vars added/removed → Tasks 1, 6, 7, 11. ✓
- Testing (worker unit: gate, seed, catch-all) → Tasks 3, 5, 6. Dashboard: smoke test → Task 11 (see Testing approach note for the deliberate deviation from per-unit dashboard tests). ✓
- Out of scope (multi-user, roles, registration, reset, rate-limit, webhook/cron auth) → untouched. ✓

**Deviations from the spec (all deliberate, surfaced):**
1. **Hand-written `auth-schema.ts` instead of `@better-auth/cli generate`.** Running the CLI loads `auth.ts`, which transitively triggers the worker's full t3-env validation (Jira/VCS/etc.) — heavy friction for a dev who just wants a schema. The hand-written file matches the verified Better Auth core schema and is guarded by the round-trip test (Task 3), which fails loudly on any column mismatch. The CLI remains a valid alternative if you prefer regeneration.
2. **`auth.ts` (pure factory) split from `auth-instance.ts` (env-bound singleton).** The spec named a single `src/auth.ts`. The split is required so unit tests can build an instance over pglite without the full env. Behaviour is identical.
3. **Dashboard verified by smoke test, not unit tests** (no test runner in the dashboard) — see the Testing approach section.

**Placeholder scan:** none — every code step contains literal code; every command has an expected result.

**Type consistency:** `createAuth(db, opts)` / `Auth` / `seedAuthUser(auth, creds)` / `assertSession(auth, headers)` used consistently across Tasks 3, 4, 5, 6. `UnauthorizedError` / `authAwareFallback(err, fallback)` consistent across Task 7 + the data files. Cookie name `ba_session` and `getSession`/`signInEmail`/`sign-in/email`/`sign-out`/`get-session` endpoints consistent across worker and dashboard.
