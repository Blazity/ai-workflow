Status: current
Last-verified: 2026-09-17

# AGENTS.md

AI Workflow turns engineering events (a Jira ticket entering a column, a pull
request event, a webhook, a schedule) into inspectable agent runs. A stored,
versioned workflow definition decides what a run does; the worker
(`apps/worker`, Nitro plus the Vercel Workflow DevKit) executes it and talks to
Jira, GitHub, GitLab, Slack and the sandboxed coding agents; the dashboard
(`apps/dashboard`, Next.js) authors definitions and shows runs.

This file is a routing table. It says which document to open, and carries only
the rules that bind every edit. Area knowledge goes to a rule (below), history
to `docs/archive/agent-notes/`; size ceilings: `.claude/context-budget.tsv`.

## Where to look

| When you work on | Read |
|---|---|
| Anything, first | [docs/index.md](docs/index.md), the only list of current documents |
| Project vocabulary | [CONTEXT.md](CONTEXT.md) |
| Dashboard visual language, tokens, shared primitives | [DESIGN.md](DESIGN.md) |
| Evidence, closing a ticket, a release | [docs/delivery-gates.md](docs/delivery-gates.md), the `gate-ladder` skill |
| Workflow definitions, blocks, bindings, triggers, loops, validation | [docs/architecture/workflow-definition.md](docs/architecture/workflow-definition.md) |
| Repository script groups and the checks blocks run | [docs/architecture/repository-scripts.md](docs/architecture/repository-scripts.md) |
| Telling users what changed | [changelog/README.md](changelog/README.md) |
| Why the code is shaped this way | [docs/adr/README.md](docs/adr/README.md) |
| Tiers, allowed imports, which package owns what | [docs/adr/ADR-001-layering-and-packages.md](docs/adr/ADR-001-layering-and-packages.md) |
| Gates, CI, what may be required and what may be bypassed | [docs/adr/ADR-004-gates-and-required-ci.md](docs/adr/ADR-004-gates-and-required-ci.md) |
| The delivered restructure: its stages, freezes and the step drain | [docs/plans/2026-09-09-architecture-restructure.md](docs/plans/2026-09-09-architecture-restructure.md) |
| Environment variables, accounts, deployment, webhooks | [SETUP.md](SETUP.md) |
| What the product does and what is planned | [README.md](README.md), [docs/product/roadmap-2026-08-27.md](docs/product/roadmap-2026-08-27.md) |
| The worker: how to run it, its directories | [apps/worker/AGENTS.md](apps/worker/AGENTS.md) |
| The dashboard: how to run it, its directories | [apps/dashboard/AGENTS.md](apps/dashboard/AGENTS.md) |
| The shared packages: source entry, exports | [packages/AGENTS.md](packages/AGENTS.md) |

Setting something up is a skill, not a document: `.claude/skills/init-*` walk
the procedure and link to the SETUP.md section that holds each constraint.

## Area rules

`.claude/rules/<name>.md` binds the files its `paths:` list names. Claude Code
loads it on a matching read; other agents open it before editing those files.

| Rule | Covers |
|---|---|
| `worker-settings` | settings snapshots, what a run may read |
| `worker-repository-catalog` | catalog access and dispatch decisions |
| `worker-database` | migrations, Drizzle schema, auth invariants |
| `workflow-steps` | `"use step"` and `"use workflow"` files, their fixtures |
| `workflow-graph` | `packages/workflow-graph` and the worker's definition half |
| `zod-bundle`, `contracts-requests` | schemas the worker bundle runs, request bodies |
| `worker-mcp`, `worker-observability` | the MCP server; logging, telemetry, the runs API |
| `adapters`, `sandbox-agents` | Jira, VCS and chat adapters; the sandboxed coding agents |
| `arthur-engine`, `e2e-tests` | the Arthur client; the end-to-end suites |
| `dashboard-ui`, `dashboard-settings`, `dashboard-repositories` | the dashboard |

## How to work here

- State assumptions before implementing. If two readings are possible, name
  both instead of silently picking one.
- Write the minimum that solves the problem. No speculative abstraction, no
  configurability nobody asked for.
- Touch only what the task requires. Match the surrounding style. Remove the
  orphans your own change creates, and mention pre-existing dead code rather
  than deleting it.
- Turn the task into a verifiable goal ("write the test that reproduces it,
  then make it pass") and loop on it yourself.
- Record a newly found defect as its own Jira issue instead of widening the
  slice you are in.

## Commands

```sh
pnpm install
pnpm dev                 # worker
pnpm dev:dashboard
pnpm run typecheck
pnpm run verify:changed  # the scope-aware gate, before pushing
```

Pick the checks that match the surface you changed, and record the exact
command and its outcome:

```sh
git diff --check
pnpm run typecheck
(cd apps/worker && pnpm run validate:pre-sandbox)
(cd apps/worker && pnpm run validate:local-skills)
(cd apps/worker && pnpm run mcp:contract:check)
pnpm run test:ci
```

Run the smallest test that reproduces the issue first, then nearby regression
tests. Root `pnpm test` and `pnpm build` are not local defaults; broad suites
belong in CI.

## Evidence

**Never report a result you did not observe.**

Before editing, record the branch and the exact 40-character start SHA. Freeze
the exact candidate SHA before verification. Never substitute a branch, tag,
alias, deployment URL, or abbreviated SHA for a full one.

Delivery state (`planned`, `in_progress`, `implemented`, `merged`, `deployed`)
and evidence verdict (`NOT_RUN`, `IN_VERIFICATION`, `PASS`, `FAIL`, `BLOCKED`)
are independent axes. Never infer one from the other. Missing evidence is never
a `PASS`, and a later result does not erase an earlier `FAIL`.

`pnpm run verify:changed` resolves the base from the branch upstream, then
`origin/HEAD`, then `origin/main`, and never fetches; pass `-- --base <ref>` to
override. The Claude Stop hook adds `--worktree` so committed, staged, unstaged
and untracked paths are planned together. Enable the pre-push hook once with
`git config --local core.hooksPath .githooks`, but only if that setting is
currently empty. The gate is advisory and bypassable: `git push --no-verify` is
an audited bypass, so record why it was used and do not report the gate as
passed.

`main` carries the branch ruleset decided in ADR-004: since 2026-09-09 it
requires the `ci` aggregator to pass, so a red `ci` job blocks the merge. The
only bypass is one named user account, and every use of it must open a Jira
issue recording what was merged and why.

## Four gotchas that break production

**neon-http has no transactions.** Production uses neon-http and cannot open
an interactive transaction (`apps/worker/src/db/client.ts`). Write multi-row changes as one statement (a data-modifying CTE, an
insert-on-conflict) rather than `db.transaction`. The pglite test driver does
support transactions, so unit tests will not catch this.

**The Workflow DevKit discovers steps by file content.** A `"use step"` file
moved where the builder does not scan fails at runtime, not at build. Guards:
`apps/worker/src/engine/workflow-import-boundary.test.ts` and
`apps/worker/src/engine/step-registration-coverage.test.ts`; run both when
engine files move. A step's identity is its module path plus its function
name, so moving or renaming one strands every run suspended in it: such a
change merges only after the [drain](docs/plans/2026-09-09-architecture-restructure.md).

**The worker build runs migrations.** `build` in `apps/worker/package.json`
calls `db:migrate` against whatever `DATABASE_URL` is set: never run it locally
by accident, and keep that path working when you touch `db/`, or the next
preview deploy mutates a database.

**Invocation ceilings.** A plain function is killed at 300 s, which is why
`apps/worker/src/infra/llm.ts` bounds a call below it. The deployed step
function ships `maxDuration` `"max"` and is killed at 800 s on Pro
(`apps/worker/src/services/run-lifecycle/workflow-step-drain.ts`). Long work
has to be resumable across invocations, not merely fast.
