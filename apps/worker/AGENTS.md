Status: current
Last-verified: 2026-09-23

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
pnpm exec vitest run src/<path>   # one file or directory, the usual loop
pnpm test                         # the full vitest suite
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
builds Nitro. `pnpm run build:ci` is the credential-free variant used in CI.
The end-to-end suites (`pnpm run test:e2e:*`) and the preview canaries need a
deployment and credentials; their `:dry` variants run locally.

## Directory map

[ADR-001](../../docs/adr/ADR-001-layering-and-packages.md) owns the tier map,
and [the architecture overview](../../docs/architecture/overview.md) owns the
service-cluster contracts. Runtime entrypoints are under `src/engine`, domain
code under `src/services`, the Nitro app surface under `src/routes` and
`src/mcp`, runtime environment and provider configuration under `src/infra`.

What one send gave a model is split by tier: `src/engine/agent-visibility/`
captures it from inside the send step, `src/run-observability/agent-briefings.ts`
writes it (the engine may not import a service), `src/services/agent-visibility/`
serves it. `src/repository-map/` renders the repository map, and both
`src/engine` and `src/sandbox` import it.

What a definition is and whether it is valid lives in
`@shared/workflow-graph`. The worker keeps the block registry, the ajv-backed
JSON Schema helpers, deployment validation, stored-definition reads, models,
layout, agent resolution and harness-profile runtime in
`src/engine/definition/`, the authoring and drift-gate half in
`src/services/workflow-definitions/`, and the suites plus the scenario corpus
in `src/workflow-graph-suites/` (see its `README.md`).

## Area rules

The worker's traps live in `.claude/rules/`, loaded when a matching file is
read: `worker-settings` (snapshots, what a run may read),
`worker-repository-catalog`, `worker-database`, `workflow-steps`,
`workflow-graph`, `zod-bundle`, `worker-mcp`, `worker-observability`,
`agent-visibility`, `adapters`, `memory`, `sandbox-agents`, `arthur-engine`,
`e2e-tests`. The production gotchas that bind every edit are in the root
router.

## Where to read next

- Definitions, blocks, bindings, loops, validation: [docs/architecture/workflow-definition.md](../../docs/architecture/workflow-definition.md)
- Repository script groups: [docs/architecture/repository-scripts.md](../../docs/architecture/repository-scripts.md)
- Tiers and allowed imports: [ADR-001](../../docs/adr/ADR-001-layering-and-packages.md)
- Gates and CI: [ADR-004](../../docs/adr/ADR-004-gates-and-required-ci.md)
- Environment variables and deployment: [SETUP.md](../../SETUP.md)
- Everything else that is current: [docs/index.md](../../docs/index.md)
