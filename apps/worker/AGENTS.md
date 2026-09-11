Status: current
Last-verified: 2026-09-11

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

Tiers come from
[ADR-001](../../docs/adr/ADR-001-layering-and-packages.md), which is the source
of truth for the mapping. The directories keep their names until the stage that
moves them.

| Directory | Tier | Note |
|---|---|---|
| `routes/` | app | Nitro scans this path, so it keeps its name; a handler holds the transport (bytes, headers, status) and a `@shared/contracts` schema for its body, and the branching belongs to a services cluster |
| `middleware/`, `plugins/`, `auth.ts`, `auth-instance.ts`, `nitro.d.ts` | app | the server surface |
| `mcp/` | app | the MCP transport, auth and tool wiring; what a tool does to the database is `services/mcp/` |
| `services/` | services | one directory per domain cluster, each with an `index.ts` interface that only other clusters import; app-tier files name the cluster module they use ([docs/architecture/overview.md](../../docs/architecture/overview.md) lists the clusters and says why) |
| `approvals/`, `clarifications/`, `manual-dispatch/`, `schedule-trigger/`, `webhook-trigger/` | services | only the store files are left here; they become db repositories in stage 7 |
| `engine/`, `workflow-definition/`, `memory/`, `post-pr-gate/`, `pre-pr-checks/`, `pre-sandbox/`, `run-analysis/`, `run-observability/`, `sandbox/` | engine | the runtime: the `"use workflow"` body, the `"use step"` functions, blocks, definition handling |
| `harness-profiles/`, `prompt-library/` | engine (runtime) | their `store.ts` moves to db, their pure parts to packages |
| `adapters/` | adapters | `adapters/vcs`, `adapters/issue-tracker`, `adapters/messaging`; `adapters/run-registry` is db, because it is one repository implementation |
| `db/` | db | the only tier that knows the driver |
| `config/`, `infra/` | config, infra | the validated env schema; the logger, LLM client, webhook signature and unique-violation helpers |
| `env.ts` | config | one schema, validated at boot |
| `test-support/`, `mcp-dogfood/`, `e2e/`, `workflow-test-fixtures/`, colocated `*.test.ts` | testing | |

## Traps specific to this app

- **The Workflow DevKit finds steps by reading files, not by imports.** A
  `"use step"` or `"use workflow"` file the builder does not scan fails at
  runtime with "is not registered in the current deployment", never at build.
  `src/engine/workflow-import-boundary.test.ts` and
  `src/engine/step-registration-coverage.test.ts` are the guards; run both
  when you move, rename or add such a file. A stray backtick in a comment can
  hide every directive below it, which is why the detector is content-based.
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
