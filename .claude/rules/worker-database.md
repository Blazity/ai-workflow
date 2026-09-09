---
paths:
  - "apps/worker/src/db/**"
  - "apps/worker/drizzle/**"
  - "apps/worker/scripts/db-migrate.ts"
  - "apps/worker/src/**/store.ts"
---

# Worker database and migrations

- Applied Drizzle migrations and their snapshots are immutable. Do NOT edit old
  `000N_*.sql` files or old `meta/000N_snapshot.json` files to express a new
  invariant: existing databases already recorded those migrations, while a
  fresh database would replay the rewritten history and drift. The safe pattern
  is a new forward migration (`000N+1_*.sql`), a new snapshot, an update to
  `meta/_journal.json` only, and a check that the diff modifies no historical
  migration SQL or snapshot.
- Migrations apply per Neon branch, at build time only. Demo, preview and
  production each need their own migrate (or a real build). When a "fixed"
  migration-drift bug recurs it is almost always a different branch that the
  earlier fix never reached: check the branch's `__drizzle_migrations` count
  and the actual column before re-diagnosing the code.
- `pnpm db:migrate` also runs the `env_marker` guard, which claims the branch
  for the current environment. Running it with no `VERCEL_ENV` re-claims the
  branch as `development` and breaks the next production build. To repair a
  branch by hand, run bare `pnpm exec drizzle-kit migrate` instead.
- Unit tests replay migrations from disk: `src/db/test-db.ts` reads the
  `drizzle/` directory in the working tree, so an uncommitted migration is
  already active in tests. Passing tests are not evidence that a deployed
  branch has the column.
- `src/db/client.ts` imports `env` at the top level, so importing it at all
  (even dynamically) validates the full worker env. A standalone or build-time
  script that must run with a subset of env (such as `scripts/seed-auth-user.ts`)
  must not import `client.js` or `getDb()`; build a driver inline and cast it.
- Auth relies on database-level invariants, not only on Better Auth logic:
  `user.email` unique case-insensitively, `account(provider_id, account_id)`
  unique, and `member.role` / `invitation.role` constrained to
  `owner|admin|member`. After adding or editing auth migrations, verify the
  deployed branch actually applied them before promoting or testing login and
  invite flows.
