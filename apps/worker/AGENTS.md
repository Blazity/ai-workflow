Status: current
Last-verified: 2026-09-13

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

`src/workflow-definition` is gone (stage 7 of
[the workflow-graph plan](../../docs/plans/2026-09-11-workflow-graph-package.md),
and listed in `scripts/gates/no-resurrected-paths.json`). What a definition is
and whether it is valid now lives in `@shared/workflow-graph`; the worker keeps
the block registry, the ajv-backed JSON Schema helpers, deployment validation,
stored-definition reads, models, layout, agent resolution and harness-profile
runtime in `src/engine/definition/`, the authoring and drift-gate half in
`src/services/workflow-definitions/`, and the suites plus the scenario corpus in
`src/workflow-graph-suites/` (see its `README.md`).

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
  tick, the MCP transport, a run at its start) and hand it down.
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
  without touching the database. A RUN loads it in one `"use step"` at the top of
  the workflow body (`loadRunStartSettingsStep`,
  `engine/steps/run-start-settings.ts`) and carries the result on the run
  context as `ctx.settings` and `ctx.repositories`; see the run context rule
  below. The repository catalog snapshot obeys the same
  rule in the same places: `getRequestRepositoryCatalogSnapshot(event)` memoised
  on the event, a `loadRepositoryCatalog` thunk beside `loadSettings` on both
  signed webhook ingresses, one load per cron tick handed into the poll pass,
  and `deps.repositoryCatalog` on `McpToolDependencies`.
- **The run context rule.** Inside a run, NOTHING re-reads either store. A step
  or a block takes its values from `ctx.settings` / `ctx.repositories` or from
  an explicit parameter, never from `env`, never from a settings accessor,
  never from a module-level cache. Two reasons, and both bite silently: a run
  outlives its read by hours, so a second read gives one run two different
  answers and a replay a different branch than the first execution took; and a
  read per element inside a loop over repositories is a database round trip per
  element. `engine/steps/run-start-settings.ts` is the only engine file allowed
  to touch `db/repositories/settings.ts` or
  `db/repositories/repository-catalog.ts`, and nothing reachable from the
  workflow isolate may import `services/settings`, `services/repository-catalog`
  or the database client at all (ADR-001 gives the engine no edge to a service;
  `engine/workflow-import-boundary.test.ts` is the guard). Because that step is
  called before every other step, a change to it changes the journal of every
  run in flight: it merges only after a production drain.
- **The transition rule.** Every accessor that reads a migrated key takes the
  snapshot: `accessor(snapshot)`. The deprecated zero-argument forms that
  resolved from the environment are gone, with one exception,
  `ticketBoardSettings()`, which three trigger entry points still call; it goes
  when the cleanup stage removes the environment parsing.
  `services/settings/consumers-guard.test.ts` scans `routes`, `services`, `mcp`,
  `infra`, `engine`, `pre-sandbox` and `workflow-graph-suites` and fails on a
  reintroduced `env.<migrated key>`, on a zero-argument accessor, on an import
  of a deleted allowlist module and on a read of `AGENT_ALLOWED_REPOS` inside a
  run. Its exemptions are written down with reasons; add one only with a reason
  that names the stage that removes it.
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
- **The bundle does not run the zod the workspace pins.** Nitro traces one
  `node_modules/zod` for the whole function and takes it from `@workflow/core`,
  which is zod 4 today, while `pnpm-workspace.yaml` pins the catalog at 3.25.
  So typecheck and `vitest run` prove a schema under zod 3 and the deployed
  function runs it under zod 4. Only the API common to both versions is safe:
  a one-argument `z.record(valueSchema)` is the zod 3 spelling, is read as
  `z.record(keySchema, valueSchema)` by zod 4, and throws `Cannot read
  properties of undefined` on the first body that carries a key, which is how
  every repository profile save answered 500 on 13.09. Curated schema errors
  use `{ message }`, which both versions honour; a union carries the same text
  in `message` and `errorMap` because zod 3 ignores the former there and zod 4
  ignores the latter. The zod 4 runs are the gate:
  `pnpm run test:packages:zod4` for the contracts and workflow-graph schemas and
  `pnpm --filter worker run test:zod4` for the MCP tool catalog. The rest of
  this app's suite does not pass under zod 4 and is not meant to; the error
  wording differs everywhere, and the worker alias run asserts refusals rather
  than sentences for that reason.
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
- **A `check()` built from interpolated values generates `$1` in the SQL.**
  drizzle-kit serializes a parameterized `sql` fragment as placeholders, so a
  constraint written as ``sql`${t.col} in (${sql.join(LIST)})` `` lands in the
  migration file as `in ($1, $2)`, which no migrator can run. Every existing
  check writes its allowed values as literals in the template
  (`src/db/schema/repositories.ts`, `src/db/schema/repository-suggestions.ts`);
  read the generated `.sql` before believing a constraint, because pglite
  replays the same broken file and the failure is identical in tests and
  production only if you look.
- **The catalog decides dispatch on four paths and access inside a run.**
  `repositories`, `repository_profile_versions` and the one-row
  `repository_catalog_state` (migration 0060) hold what the deployment knows
  about each repository and the versioned profile carrying its description,
  rules, relationships and script groups. Every access goes through
  `src/db/repositories/repository-catalog.ts`; `src/services/repository-catalog/`
  loads one immutable snapshot per entry point (`store.ts`) and answers the
  synchronous predicate from it (`policy.ts`). While `repository_catalog_state`
  says not activated the catalog is a **bridge**: it answers "enabled" for every
  repository and reports that it is doing so, which is exactly how the
  deployment behaves today. **The services tier decides dispatch from it now, on
  four paths:** a pull request or merge request event on either webhook, the
  legacy post-PR gate they fall back to, a manual pull request dispatch, and an
  MCP dispatch (with save and publish reporting the same answer for a graph's
  pins). Each asks `isRepositoryDispatchable`
  (`services/dispatch/repo-allowlist.ts`, snapshot in, boolean out) with the
  snapshot its entry point loaded. A definition's repository pin is a **selection
  inside the catalog** and extends nothing, neither dispatch nor in-run access,
  which is why the stage C seed imported every pinned repository as an enabled
  row. The same catalog decides
  access INSIDE a run: the run-start step freezes the enabled key list onto
  `ctx.repositories`, and discovery, the expansion protocol, the publisher,
  promotion, pull requests, comments and fetch-context all answer from it
  through `engine/support/repository-access.ts`. A repository enabled here is
  therefore reachable, with no variable to keep in step. A ticket-driven run
  (`dispatchTicket`, from the Jira webhook and the poll) still chooses WHICH
  repositories it works on inside the run, from discovery and the expansion
  protocol, but it chooses from that frozen list. The list is frozen at run
  start on purpose: disabling a repository stops the NEXT run, not one already
  in flight. A ticket trigger is not one of the four dispatch paths, so a ticket
  moved into the AI column starts a run whatever the catalog says; on an
  ACTIVATED catalog that enables nothing, a run whose DEPLOYED graph needs a
  checkout (`runStartHasNoEnabledRepository` and
  `workflowNeedsRepositoryAccess`, applied once the definition has loaded) fails
  through the transparent-failure exit rather than preparing a workspace it may
  not touch, while a triage graph that needs no repository runs as it always
  did. The refusal sentence is the record: it is the run's status reason and the
  ticket comment, and there is no failure-kind column behind it. The build-time
  seed
  `scripts/db-seed-repository-catalog.ts` (wired after `db:migrate` in `build`,
  never in `build:ci`) imports the allowlist variable and every pinned
  repository, activates only a deployment whose allowlist was already
  restricting it, and moves the global script groups blob into profiles; every
  write in it is guarded on existence, so a redeploy seeds nothing new. It
  refuses to guess a provider: an allowlist entry nothing else names on a
  deployment with no configured provider fails the build rather than creating a
  row that grants the wrong thing. A row is created **disabled** by every path
  except the seed and the enabled route: writing a profile configures a
  repository, it never grants one. Each repository carries two counters,
  `current_profile_version` (every save) and `current_checks_version` (only a
  change to the script groups or the gate selection); the workspace gate records
  the CHECKS version, pinned when the checks were launched and carried out of
  `loadPrePrCheckConfigStep`, in an optional `repositoryVersions` field, and
  recovery accepts a gate with or without it indefinitely. **Nothing on the gate
  path may become a step:** one extra step call there shifts every later journal
  entry of a run already in flight, and the Workflow DevKit resumes by consuming
  that journal in order.

- **The MCP contract is generated.** After changing a tool, run
  `pnpm run mcp:contract:generate`, and `mcp:contract:check` in CI proves it.

## Where to read next

- Definitions, blocks, bindings, loops, validation: [docs/architecture/workflow-definition.md](../../docs/architecture/workflow-definition.md)
- Repository script groups: [docs/architecture/repository-scripts.md](../../docs/architecture/repository-scripts.md)
- Tiers and allowed imports: [ADR-001](../../docs/adr/ADR-001-layering-and-packages.md)
- Gates and CI: [ADR-004](../../docs/adr/ADR-004-gates-and-required-ci.md)
- Environment variables and deployment: [SETUP.md](../../SETUP.md)
- Everything else that is current: [docs/index.md](../../docs/index.md)
