Status: current
Last-verified: 2026-09-09

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

From `apps/worker` (every script starts by building the shared contracts, so
run them through pnpm, not `vitest` directly):

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
| `routes/` | app | Nitro scans this path, so it keeps its name |
| `middleware/`, `plugins/`, `auth.ts`, `auth-instance.ts`, `nitro.d.ts` | app | the server surface |
| `mcp/` | app | MCP tools, auth, catalog, contract |
| `approvals/`, `clarifications/`, `dispatch-queue/`, `manual-dispatch/`, `repository-discovery/`, `schedule-trigger/`, `system-health/`, `webhook-trigger/` | services | mixed today: `store.ts` files belong to db, files carrying `"use step"` belong to engine |
| `deployment-identity.ts` | services | |
| `workflows/`, `workflow-definition/`, `memory/`, `post-pr-gate/`, `pre-pr-checks/`, `pre-sandbox/`, `run-analysis/`, `run-observability/`, `sandbox/` | engine | the runtime: the `"use workflow"` body, the `"use step"` functions, blocks, definition handling |
| `harness-profiles/`, `prompt-library/` | engine (runtime) | their `store.ts` moves to db, their pure parts to packages |
| `adapters/` | adapters | `adapters/vcs`, `adapters/issue-tracker`, `adapters/messaging`; `adapters/run-registry` is db, because it is one repository implementation |
| `db/` | db | the only tier that knows the driver |
| `lib/` | split by file | env accessors are config; logger, telemetry, llm, llm-provider, github-webhook-sig, webhook-crypto, unique-violation, vcs-urls are infra; the rest (dispatch, run-lifecycle, tickets, publication, overview, auth, slack) are services |
| `env.ts` | config | one schema, validated at boot |
| `test-support/`, `mcp-dogfood/`, `e2e/`, `workflow-test-fixtures/`, colocated `*.test.ts` | testing | |

## Traps specific to this app

- **The Workflow DevKit finds steps by reading files, not by imports.** A
  `"use step"` or `"use workflow"` file the builder does not scan fails at
  runtime with "is not registered in the current deployment", never at build.
  `src/workflows/workflow-import-boundary.test.ts` and
  `src/workflows/step-registration-coverage.test.ts` are the guards; run both
  when you move, rename or add such a file. A stray backtick in a comment can
  hide every directive below it, which is why the detector is content-based.
- **`agent.ts` has no top-level adapter or logger imports.** Inside a step,
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
  `src/lib/workflow-step-drain.ts` and `src/lib/run-stall-watchdog.ts`.
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
