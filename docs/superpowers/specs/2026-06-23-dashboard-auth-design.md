# Dashboard auth (Better Auth, worker as backend) — design

**Date:** 2026-06-23
**Status:** Approved (design); pending spec review → implementation plan

## Problem

The dashboard (`apps/dashboard`, a separate Vercel deployment) has **no human
authentication**. There is no login page and no `middleware.ts`; every
`(cockpit)` page is publicly reachable. Data reaches the browser two ways, and
**both are currently open to anyone with the URL**:

1. **Server components** (`app/*-data.tsx`) fetch the worker's `/api/v1/*`
   during SSR via `getJSON` (`lib/api/server.ts`).
2. **Dashboard proxy API routes** (`app/api/runs/search`,
   `app/api/prompts/[name]/versions/[version]`) are browser-reachable
   same-origin endpoints that relay to the worker. e.g. an unauthenticated
   browser can hit `/api/runs/search?q=` today and get worker data back.

The worker (`apps/worker`, Nitro) already gates its `/api/v1/*` endpoints with a
**static shared bearer** (`WORKER_API_TOKEN`, see `src/middleware/api-auth.ts` +
`src/lib/api-auth.ts`) — machine-to-machine only, no notion of a human user.

We want: **login with predefined credentials from env (no registration), and a
valid human session required before any data is fetched into the dashboard.**

## Decisions (confirmed with user)

| Knob | Value |
| --- | --- |
| Library | **Better Auth** (`better-auth`) |
| Auth authority location | **The worker** — single backend for auth + data |
| Session transport (cross-domain) | **Dashboard BFF + bearer token in a first-party `httpOnly` cookie** (browser never talks to the worker) |
| Registration | **None** — sign-up endpoint disabled; one predefined user seeded from env |
| Password hashing | **Better Auth default scrypt** (pure-JS; works on Vercel serverless — avoid native argon2) |
| Auth DB | **Reuse the worker's Neon** (`DATABASE_URL`) via the Better Auth drizzle adapter |
| `WORKER_API_TOKEN` | **Retired** — the valid-session check replaces it as the `/api/v1/*` gate |
| Session length | **7 days, rolling refresh** (Better Auth default) |

### Why worker-side auth + a dashboard BFF

The worker is the single backend, so auth logic lives there (it already owns
Neon + drizzle). But the worker and dashboard are **separate deployments on
different domains**, and Vercel's default `*.vercel.app` domains cannot share a
cookie (public suffix). Rather than require a shared custom parent domain or put
a token in JS-readable browser storage, the **dashboard stays a thin BFF**: the
browser only ever talks to the dashboard origin, and the worker-issued session
token rides in the dashboard's own `httpOnly` cookie, replayed server-side as a
`Bearer` on every worker call. This preserves today's "browser never holds the
worker secret" property and needs no CORS.

### Rejected alternatives

- **Auth in the dashboard (same-origin)** — simplest cookie/middleware story,
  but the user wants the worker to be the single backend/auth authority.
- **Browser → worker directly (pure client)** — needs a shared parent custom
  domain (breaks on `*.vercel.app`) or a token in JS-readable storage, plus CORS
  + `trustedOrigins`; exposes the worker origin to the browser. More moving
  parts, weaker security posture.
- **Minimal custom signed-cookie / Auth.js Credentials** — rejected in favour of
  Better Auth per the user.

## Architecture

```
┌─────────── browser ───────────┐         ┌──────────── worker (Nitro) ────────────┐
│  /login  (form, same-origin)   │  POST   │  /api/auth/**   Better Auth handler      │
│  (cockpit) pages               │ ──────► │     ├─ sign-in/email, sign-out, session  │
│  cookie: ba_session (httpOnly) │         │     └─ bearer plugin, trustedOrigins      │
└────────────────┬───────────────┘         │  /api/v1/**     gate: valid session       │
                 │ server-side only          │  Neon (Better Auth tables + app data)    │
   middleware + BFF routes + SSR  ──────────►│  webhooks/cron: unchanged                 │
   Authorization: Bearer <token>            └───────────────────────────────────────────┘
```

### Worker — new

1. **`src/auth.ts`** — `betterAuth({ ... })`:
   - `database`: drizzle adapter over the existing Neon client.
   - `emailAndPassword: { enabled: true, disableSignUp: true }`.
   - `plugins: [bearer()]` — sign-in returns the session token in the
     `set-auth-token` response header / JSON body for the dashboard to store.
   - `trustedOrigins: [DASHBOARD_ORIGIN]`.
   - `secret: BETTER_AUTH_SECRET`, `baseURL: BETTER_AUTH_URL`.
   - default scrypt hashing (no argon2).
2. **`src/routes/api/auth/[...all].ts`** — catch-all that adapts the incoming h3
   event to a Web `Request`, calls `auth.handler(request)`, and returns the Web
   `Response`. (Better Auth's handler is framework-agnostic; Nitro/h3 speaks
   Web Request/Response.)
3. **Better Auth schema** — generate the `user` / `session` / `account` /
   `verification` tables into the worker's drizzle schema; add the migration.
   Migrations already run in `build` via `pnpm db:migrate`.
4. **`scripts/seed-auth-user.ts`** — idempotently create/update the single admin
   from `DASHBOARD_AUTH_EMAIL` / `DASHBOARD_AUTH_PASSWORD` (create if absent;
   re-hash if the env password changed). Runs in `build` after `db:migrate`;
   also runnable manually. Uses Better Auth's server API so hashing/account
   linking match the sign-in path.

### Worker — changed

5. **`src/middleware/api-auth.ts`** — `/api/v1/**` now requires a **valid Better
   Auth session** (`auth.api.getSession({ headers })` → 401 if none) instead of
   the static `WORKER_API_TOKEN`. `/api/auth/**`, `/webhooks/**` (HMAC), and
   `/cron/**` keep their existing handling and are **not** session-gated.
   `src/lib/api-auth.ts` (`verifyApiToken`) and the `WORKER_API_TOKEN` env are
   removed.

### Dashboard — new

6. **`middleware.ts`** — for `(cockpit)` routes, no `ba_session` cookie →
   redirect to `/login`. (Cheap presence check; real validation happens in #9.)
7. **`app/login/page.tsx`** + **`app/api/auth/login/route.ts`** (or a server
   action) — posts email+password to the worker `/api/auth/sign-in/email`; on
   success, stores the returned session token in the `ba_session` cookie
   (`httpOnly`, `secure`, `sameSite=lax`) and redirects to `/`.
8. **`app/api/auth/logout/route.ts`** — calls worker `/api/auth/sign-out` with
   the bearer, clears `ba_session`, redirects to `/login`.
9. **`requireSession()` helper** — used by `(cockpit)/layout.tsx`: validates the
   cookie token against the worker (`/api/auth/get-session`); invalid → clear
   cookie + redirect to `/login`. One round-trip per page load gates **all**
   cockpit pages in one place.

### Dashboard — changed

10. **`lib/api/server.ts`** — `getJSON` reads `ba_session` from cookies and sends
    `Authorization: Bearer <token>`; on a `401` it throws a typed
    `UnauthorizedError` (see Error handling). `WORKER_BASE_URL` stays;
    `WORKER_API_TOKEN` usage removed.

## Data & credential flow

1. **Login:** browser → dashboard login route → worker `sign-in/email` → worker
   verifies vs. the seeded user → returns session token → dashboard sets
   `ba_session` → redirect `/`.
2. **Page load:** `middleware.ts` confirms cookie presence; `(cockpit)/layout.tsx`
   `requireSession()` validates against the worker → invalid → `/login`.
3. **Data fetch (SSR + `/api/*` proxies):** dashboard attaches the bearer; worker
   `/api/v1/**` validates the session and serves data.
4. **Logout:** clears `ba_session` + worker sign-out.

**User model:** exactly one predefined admin (email+password from env). No
registration UI; the sign-up endpoint is disabled. The login form collects
**email + password** (Better Auth's email/password identity).

## Error handling

- **Wrong credentials** → worker `401` → login page shows "Invalid credentials."
- **Expired/invalid session mid-use** → worker `401`. Today `getJSON` swallows
  errors into mock fallbacks (e.g. `runs-data.tsx`'s `.catch(() => fallback)`).
  After this change, a `401` becomes a typed `UnauthorizedError` that an auth
  boundary catches → clear cookie + redirect to `/login`. **Non-auth** errors
  (worker down, timeout, 5xx) keep today's graceful mock fallback. This is the
  one place auth interacts with existing dashboard behaviour.
- **Misconfiguration** (missing `BETTER_AUTH_SECRET`, unseeded user, DB down) →
  auth **fails closed**: login errors out; the dashboard never falls back to
  showing data without a valid session.

## Env vars

**Worker (new):** `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (worker base URL),
`DASHBOARD_ORIGIN` (for `trustedOrigins`), `DASHBOARD_AUTH_EMAIL`,
`DASHBOARD_AUTH_PASSWORD`. **Reuses** `DATABASE_URL`.

**Dashboard:** **reuses** `WORKER_BASE_URL`; **no new secret** (the cookie holds
the opaque worker-issued token, validated by the worker).

**Removed:** `WORKER_API_TOKEN` from both apps and from `SETUP.md` / `README.md`.

## Testing

- **Worker unit:**
  - `/api/v1/**` gate: valid session → 200; expired/invalid/missing → 401.
  - Seed: creates the user when absent; re-hashes when the env password changes;
    no duplicate on re-run.
  - Auth catch-all wiring: a request to `/api/auth/*` is handled by Better Auth.
- **Dashboard unit:**
  - `middleware.ts`: `(cockpit)` route without cookie → redirect to `/login`.
  - Login route sets `ba_session` from the worker's token; logout clears it.
  - `getJSON` attaches the bearer and raises `UnauthorizedError` on 401.
- **Smoke (manual / e2e):** login → load a cockpit page with data → logout →
  blocked. (Independent of the orchestration e2e, which can't run locally.)

## Out of scope

- Multiple users, roles/permissions, registration, password reset, social/SSO.
- Rate limiting / lockout on the login form (can be added later via Better Auth).
- Migrating any other worker auth (webhooks HMAC, cron) — unchanged.
