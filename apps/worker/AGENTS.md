Status: current
Last-verified: 2026-09-12

# apps/worker

The worker is the whole backend: a Nitro server that receives events (Jira
webhooks, VCS webhooks, cron, authenticated webhook triggers, MCP calls),
decides which workflow definition matches, and runs it through the Vercel
Workflow DevKit. Steps talk to Jira, GitHub, GitLab, Slack, the LLM providers
and the Vercel Sandbox that the coding agent runs in. It owns the database
(Drizzle plus Neon) and the MCP server.

Root instructions: [../../AGENTS.md](../../AGENTS.md). Read those first; this
file adds only what is true of the worker.

## Run and test

From `apps/worker` (the workspace packages under `packages/` are consumed as
TypeScript source, so no build step precedes these):

```sh
pnpm run dev                      # nitro dev
pnpm run typecheck                # tsc --noEmit
pnpm test                         # the full vitest suite
pnpm exec vitest run src/<path>   # one file or directory, the usual loop
pnpm run validate:pre-sandbox     # pre-sandbox.yaml config
pnpm run validate:local-skills    # skills-lock.json against the skill tree
pnpm run mcp:contract:check       # the MCP contract is current
pnpm run check:prompt-drift       # built-in prompts match the migrations
pnpm run check:carry-schema-drift # loop carry schemas match
pnpm run db:generate              # write a migration from the schema
pnpm run db:migrate               # apply migrations (also runs inside build)
```

`pnpm run build` is not a local default: it runs the validators, applies
migrations to whatever `DATABASE_URL` is set, seeds the auth user, and then
builds Nitro with an 8 GB heap. `pnpm run build:ci` is the credential-free
variant used in CI.

The end-to-end suites (`pnpm run test:e2e:*`) and the two preview canaries
(`test:e2e:harness-profiles`, `test:e2e:replay`) need a deployment and
credentials. Their `:dry` variants run locally.

## Directory map

[ADR-001](../../docs/adr/ADR-001-layering-and-packages.md) owns the tier map,
and [the architecture overview](../../docs/architecture/overview.md) owns the
service-cluster contracts. The current runtime entrypoints are under
`src/engine`, domain code is under `src/services`, the Nitro app surface is
under `src/routes` and `src/mcp`, and configuration helpers are under
`src/config` and `src/infra`. Use those documents when a change crosses a
boundary instead of copying their ownership tables here.

## Settings

Product-behaviour switches (limits, feature flags, MCP bounds, board column
names, harness defaults) are rows in the `settings` table, described once in
`packages/contracts/settings-registry.ts` and changed through
`PATCH /api/v1/settings` by an owner or admin, with every change recorded in
`settings_versions` with the actor and a reason.

- **One snapshot per entry, passed down.** `loadSettingsSnapshot()` is
  asynchronous and everything below it is not: an accessor returns a value, and
  an accessor that quietly returned a promise would read as truthy and turn a
  feature on. Load the snapshot where the work starts (an HTTP handler, a cron
  tick, the MCP transport, and later a run at its start) and hand it down.
- **Where each entry loads it.** An HTTP handler calls
  `getRequestSettingsSnapshot(event)`, which memoises the load on the event, so
  the actor guard, the handler and every service below them share one read; a
  cron tick loads once at the top of the route and passes the snapshot into the
  pass, which hands it to every phase; the MCP transport loads once per call and
  puts it on `McpToolDependencies`, so a tool reads `deps.settings` and never a
  global. The transport loads before `requireMcpActor` because `MCP_ENABLED` and
  `MCP_MAX_REQUEST_BYTES` are consulted first, which is deliberate and is the one
  place a load before authentication is accepted: the public webhook ingresses do
  the opposite and take a `loadSettings` thunk, so a bad signature is refused
  without touching the database. Engine files are the exception and still call
  the deprecated zero-argument form until the engine wave (stage X) gives a run
  its own snapshot at run start.
- **The transition rule.** Every accessor that reads a migrated key has two
  forms: `accessor(snapshot)`, which is the one to use, and a deprecated
  zero-argument form that resolves from the environment through
  `settingsSnapshotFromEnvironment()`. The second exists only so callers that
  have not been converted yet behave exactly as before; both disappear into one
  when the cleanup stage removes the environment parsing.
- **Resolution order.** Stored row, then the value the environment already
  resolved to, then the registry default. A deployment with a configured
  environment and an empty table behaves exactly as it did before the table
  existed, which is what makes the migration safe to deploy on its own.
- **The seed.** `pnpm db:seed-settings` runs right after `db:migrate` in
  `build` (not in `build:ci`) and inserts one row per key whose variable this
  deployment actually sets, doing nothing on conflict. It never overwrites a
  decision made in the dashboard, and it writes no version rows: the
  environment is not an actor. A later save of the same value writes no version
  row either, because the write skips a row whose value is not distinct from
  the one stored, so an empty history on a seeded key means "never changed",
  not "never decided".

## Traps specific to this app

- **The Workflow DevKit finds steps by reading files, not by imports.** A
  `"use step"` or `"use workflow"` file the builder does not scan fails at
  runtime with "is not registered in the current deployment", never at build.
  `src/engine/workflow-import-boundary.test.ts` and
  `src/engine/step-registration-coverage.test.ts` are the guards; run both
  when you move, rename or add such a file. A stray backtick in a comment can
  hide every directive below it, which is why the detector is content-based.
- **A fixture reaches worker source without a file extension.** The Workflow
  builder's discovery resolves a relative specifier literally, so
  `../../src/foo.js` from `workflow-test-fixtures/` matches nothing on disk and
  the whole chain below it drops out of the builder's import graph. The builder
  then cannot see that a `@shared/*` package is reachable from a step, leaves it
  external, and Node loads `packages/<name>/index.ts` raw: its extensionless
  re-exports are unresolvable there, so every test in
  `pnpm run test:workflow-sdk` times out on
  `Cannot find module .../packages/<name>/<file>`. Import worker source from a
  fixture as `../../src/foo`, and let `verify:changed` plan the suite.
- **`engine/agent-workflow.ts` has no top-level adapter or logger imports.** Inside a step,
  `logger` and adapters are deferred `await import(...)` calls. Do not add a
  top-level import to that module, and do not assume one exists.
- **`build` writes to the database.** It calls `db:migrate` against whatever
  `DATABASE_URL` is in the environment. Never run `pnpm run build` pointed at
  production data by accident, and keep that path working when you touch `db/`.
- **Production has no interactive transactions.** The Neon HTTP driver cannot
  open one; the pglite test driver can, so a `db.transaction` call passes every
  unit test and fails in production. Write one statement (a data-modifying CTE,
  an insert-on-conflict) instead.
- **Invocation ceilings are real.** A plain function is killed at 300 s; the
  deployed step function ships `maxDuration` `"max"` and is killed at 800 s on
  Pro. Anything long has to be resumable across invocations. See
  `src/services/run-lifecycle/workflow-step-drain.ts` and
  `src/services/run-lifecycle/run-stall-watchdog.ts`.
- **Tests replay migrations from disk.** `src/db/test-db.ts` reads the
  `drizzle/` directory in the working tree, so a freshly generated, uncommitted
  migration is already active in unit tests.
- **The MCP contract is generated.** After changing a tool, run
  `pnpm run mcp:contract:generate`, and `mcp:contract:check` in CI proves it.

## Where to read next

- Definitions, blocks, bindings, loops, validation: [docs/architecture/workflow-definition.md](../../docs/architecture/workflow-definition.md)
- Repository script groups: [docs/architecture/repository-scripts.md](../../docs/architecture/repository-scripts.md)
- Tiers and allowed imports: [ADR-001](../../docs/adr/ADR-001-layering-and-packages.md)
- Gates and CI: [ADR-004](../../docs/adr/ADR-004-gates-and-required-ci.md)
- Environment variables and deployment: [SETUP.md](../../SETUP.md)
- Everything else that is current: [docs/index.md](../../docs/index.md)
