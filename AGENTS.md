Status: current
Last-verified: 2026-09-09

# AGENTS.md

AI Workflow turns engineering events (a Jira ticket entering a column, a pull
request event, a webhook, a schedule) into inspectable agent runs. A stored,
versioned workflow definition decides what a run does; the worker
(`apps/worker`, Nitro plus the Vercel Workflow DevKit) executes it and talks to
Jira, GitHub, GitLab, Slack and the sandboxed coding agents; the dashboard
(`apps/dashboard`, Next.js) authors definitions and shows runs.

This file is a routing table. It says which document to open, and carries only
the rules that bind every edit.

## Where to look

| When you work on | Read |
|---|---|
| Anything, first | [docs/index.md](docs/index.md), the only list of current documents |
| Words that mean something specific here | [CONTEXT.md](CONTEXT.md) |
| Evidence, closing a ticket, a release | [docs/delivery-gates.md](docs/delivery-gates.md) |
| Workflow definitions, blocks, bindings, triggers, loops, validation | [docs/architecture/workflow-definition.md](docs/architecture/workflow-definition.md) |
| Repository script groups and the checks blocks run | [docs/architecture/repository-scripts.md](docs/architecture/repository-scripts.md) |
| Why the code is shaped this way, or a rule you want to change | [docs/adr/README.md](docs/adr/README.md) |
| Tiers, allowed imports, which package owns what | [docs/adr/ADR-001-layering-and-packages.md](docs/adr/ADR-001-layering-and-packages.md) |
| Gates, CI, what may be required and what may be bypassed | [docs/adr/ADR-004-gates-and-required-ci.md](docs/adr/ADR-004-gates-and-required-ci.md) |
| The restructure in flight, its stages and freezes | [docs/plans/2026-09-09-architecture-restructure.md](docs/plans/2026-09-09-architecture-restructure.md) |
| Environment variables, accounts, deployment, webhooks | [SETUP.md](SETUP.md) |
| What the product does and what is planned | [README.md](README.md), [docs/product/roadmap-2026-08-27.md](docs/product/roadmap-2026-08-27.md) |
| The worker: how to run it, its directories, its traps | [apps/worker/AGENTS.md](apps/worker/AGENTS.md) |
| The dashboard: how to run it, its directories, its traps | [apps/dashboard/AGENTS.md](apps/dashboard/AGENTS.md) |
| The shared packages: source entry, exports, their traps | [packages/AGENTS.md](packages/AGENTS.md) |

Setting something up is a skill, not a document: `.claude/skills/init-*` walk
the procedure and link to the SETUP.md section that holds each constraint.

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
override. Enable it as a hook once with
`git config --local core.hooksPath .githooks`, but only if that setting is
currently empty. The gate is advisory and bypassable: `git push --no-verify` is
an audited bypass, so record why it was used and do not report the gate as
passed.

Nothing enforces CI at merge time yet. `main` has no branch protection and no
ruleset, by recorded decision, so a red `ci` job stops nothing. ADR-004 decides
what replaces that (a ruleset requiring the `ci` aggregator, with exactly one
named bypass actor, every use of the bypass opening a Jira issue) and that flip
is the open remainder of AIW-313. Until it lands, a green run is evidence of
correctness, never proof that a red candidate could not land.

The full gate ladder, the evidence-bundle schema, the Jira disposition rules
and release authority live in [docs/delivery-gates.md](docs/delivery-gates.md).
Read that when preparing evidence, closing a ticket, or working on a release,
not on every edit.

## Four gotchas that break production

Each is quoted verbatim from the file that owns it.

**neon-http has no transactions** (`apps/worker/src/approvals/store.ts`):

> Production uses neon-http and cannot open an interactive transaction.

Write multi-row changes as one statement (a data-modifying CTE, an
insert-on-conflict) rather than `db.transaction`. The pglite test driver does
support transactions, so unit tests will not catch this.

**The Workflow DevKit discovers steps by file content**
(`docs/research/2026-09-09-architecture-audit.md`, section 10):

> Moving a `"use step"` file to a path the builder does not scan fails at
> runtime, not at build.

`apps/worker/src/workflows/workflow-import-boundary.test.ts` and
`step-registration-coverage.test.ts` are the guards. Run them in any change
that moves engine files.

**The worker build runs migrations**
(`docs/research/2026-09-09-architecture-audit.md`, section 10):

> `apps/worker/package.json` `build` calls `db:migrate`. Any stage that touches
> `db/` must keep that path working or the next preview deploy mutates a
> database.

**The invocation ceiling** (`apps/worker/src/lib/llm.ts`):

> Must stay under the platform's function timeout (300s by default, and this
> project sets no maxDuration). At exactly 300s the platform kill races the
> abort, so the block would surface an opaque platform error instead of the
> clean call_llm failure this bound exists to produce.

The deployed step function is the exception: it ships `maxDuration` `"max"`,
which resolves to 800 s on Pro, and the runtime kills the invocation there
(`apps/worker/src/lib/workflow-step-drain.ts`). Long work has to be resumable
across invocations, not merely fast.
