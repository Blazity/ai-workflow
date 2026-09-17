---
paths:
  - "apps/worker/src/db/**"
  - "apps/worker/drizzle/**"
  - "apps/worker/scripts/db-migrate.ts"
  - "apps/worker/src/**/store.ts"
  - "apps/worker/src/services/auth/**"
---

# Worker database and migrations

- Applied Drizzle migrations and their snapshots are immutable. Do NOT edit old
  migration SQL files or old snapshot JSON files to express a new
  invariant: existing databases already recorded those migrations, while a
  fresh database would replay the rewritten history and drift. The safe pattern
  is a new forward migration, a new snapshot, an update to
  `apps/worker/drizzle/meta/_journal.json` only, and a check that the diff
  modifies no historical migration SQL or snapshot.
- Deployment migrations apply per Neon branch at build time. Demo, preview and
  production each need their own migrate (or a real build). When a "fixed"
  migration-drift bug recurs it is almost always a different branch that the
  earlier fix never reached: check the branch's `__drizzle_migrations` count
  and the actual column before re-diagnosing the code.
- `(cd apps/worker && pnpm db:migrate)` also runs the `env_marker` guard, which
  claims the branch for the current environment. Running it with no
  `VERCEL_ENV` re-claims the branch as `development` and breaks the next
  production build. To repair a branch by hand from `apps/worker`, run bare
  `pnpm exec drizzle-kit migrate` instead.
- Unit tests replay migrations from disk:
  `apps/worker/src/db/test-db.ts` reads the
  `apps/worker/drizzle/` directory in the working tree, so an uncommitted
  migration is already active in tests. Passing tests are not evidence that a
  deployed branch has the column.
- Auth relies on database-level invariants, not only on Better Auth logic:
  `user.email` unique case-insensitively, `account(provider_id, account_id)`
  unique, and `member.role` / `invitation.role` constrained to
  `owner|admin|member`. After adding or editing auth migrations, verify the
  deployed branch actually applied them before promoting or testing login and
  invite flows.
- Write allowed values as SQL literals inside a Drizzle `check()` constraint.
  Interpolating values into an `sql` fragment makes drizzle-kit serialize
  placeholders such as `$1`, which no migrator can execute. Follow the literal
  examples in `apps/worker/src/db/schema/repositories.ts` and
  `apps/worker/src/db/schema/repository-suggestions.ts`, then inspect the
  generated SQL before relying on the constraint.

History: docs/archive/agent-notes/worker-runtime.md
