---
name: init-neon
description: Configure the Neon Postgres database for Blazebot (run registry + post-PR gate store) via the Vercel Marketplace. Verifies DATABASE_URL is injected per environment, that environments do NOT share a branch, and that migrations apply. Use for "set up neon", "set up postgres", "configure database", "fix run registry", "env_marker error".
---

# Initialize Neon Postgres

Walks the user through installing **Neon Postgres** from the Vercel Marketplace with branch-per-environment enabled so Vercel auto-injects a separate `DATABASE_URL` per environment that `env.ts` expects.

Blazebot uses Postgres as its run registry and post-PR-gate store — tracking active workflow runs per ticket, deduplicating dispatch, and locking concurrent cron cycles. Tables are created automatically; migrations run during every deploy's build step (`apps/worker/scripts/db-migrate.ts`).

> If you want full project setup (Jira + VCS + Agent + Slack + Neon + deploy), invoke `init-env` instead. This skill only handles Neon.

## Precondition

`.vercel/project.json` must exist. If missing:

```
ERROR: no Vercel project linked. Run `vercel link` first, or invoke `init-env`
for the full first-time setup.
```

Halt.

## State detection

1. `vercel env ls | grep DATABASE_URL` — if present for all three environments, skip install and go to verification.
2. If missing: walk the user through the Marketplace install below.

## Step 1 — Marketplace install

Walk the user through these steps (Vercel dashboard install is faster than CLI):

1. Open https://vercel.com/marketplace/neon and click **Install**.
2. Select the team and connect it to the ai-workflow Vercel project.
3. **Critical:** enable **branch per environment** (development / preview / production) when configuring the integration. Each environment's `DATABASE_URL` must point at its own Neon branch. The build fails with an `env_marker` error if two environments share one branch — that guard protects the production run registry from preview deployments.
4. Confirm the install. Vercel auto-injects `DATABASE_URL` for all three environments.

CLI alternative: `vercel integration add neon`

## Step 2 — Confirm the key landed

Tell the user to confirm in Vercel → Project Settings → Environment Variables that they see `DATABASE_URL` scoped to all three environments (Production, Preview, Development).

CLI alternative (faster from a terminal):

```bash
vercel env ls | grep DATABASE_URL
```

Success: `DATABASE_URL` appears for each of the three environments, with different values (distinct `ep-…` endpoint hosts confirm branch isolation; ignore any `-pooler` suffix when comparing hosts — pooled vs direct URLs of the same branch differ textually).

If `DATABASE_URL` is missing or the same value appears across environments, the branch-per-environment option wasn't enabled during install. Recovery paths:

- **Easier:** disconnect the Neon integration (Project → Storage → Neon → Disconnect), reinstall with branch-per-environment enabled.
- **Manual fix:** in the Neon console, create separate branches per environment and update each environment's `DATABASE_URL` in Vercel manually. Works but the integration won't keep them in sync automatically.

## Verification (all must pass)

1. `vercel env ls` shows `DATABASE_URL` for development, preview, and production.
2. Branch isolation: pull each environment's value and confirm the hosts differ (`vercel env pull --environment=production .env.prod` etc., compare the `ep-…` endpoint hosts; ignore any `-pooler` suffix when comparing hosts — pooled vs direct URLs of the same branch differ textually). Identical hosts across environments = the build's `env_marker` guard will fail — fix the integration's branch settings.
3. Migrations: `cd apps/worker && vercel env pull .env.local && pnpm db:migrate` against the development branch — expect "[db-migrate] OK — branch claimed by 'development'." (The script loads `.env.local` then `.env` via dotenv; vars already set in the shell env are never overridden.)

## Step 3 — Done

No paste-template needed — `DATABASE_URL` is auto-injected by Vercel. The end-of-flow validator (in `init-env`) confirms it made it.

If invoked from `init-env`, return control. If standalone, end.

## Troubleshooting

- Build fails with `[db-migrate] FATAL: this Neon branch is already claimed by VERCEL_ENV='production', but this build is VERCEL_ENV='…'`: two environments share one Neon branch (the `env_marker` guard). Reconfigure the integration for branch-per-environment, redeploy.
- `DATABASE_URL undefined` at build: integration not connected to this project, or env var scoped to the wrong environments.
- Stale run registry (e.g. after a bad deploy or smoke test): run `pnpm exec tsx scripts/clear-run-registry.ts <ticket>` from `apps/worker` (after `vercel env pull .env.local`) to dump and clear `active_runs` / `failed_tickets` / `thread_parents`.

## Don'ts

- **Don't manually create a Neon database outside the Marketplace.** You'd lose the auto-injection benefit and have to manage `DATABASE_URL` by hand. The Marketplace integration is the preferred path.
- **Don't share one Neon branch across environments.** The `env_marker` build guard will fail — it's there to protect the production run registry from preview deployments polluting it.
- **Don't skip branch isolation.** A preview deploy writing to the production Neon branch corrupts the run registry and can orphan live sandboxes.
