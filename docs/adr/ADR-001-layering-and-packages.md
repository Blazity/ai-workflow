Status: current
Last-verified: 2026-09-09

# ADR-001: Layering and packages

Decision status: Accepted

Source: decisions D1, D2 and D3 of
[docs/plans/2026-09-09-architecture-restructure.md](../plans/2026-09-09-architecture-restructure.md).
Measurements cited below come from
[docs/research/2026-09-09-architecture-audit.md](../research/2026-09-09-architecture-audit.md),
sections 2 and 3; they are not re-measured here.

## Context

The worker has 28 top-level directories under `apps/worker/src` and 28 two-way
import cycles between them (audit section 2). `routes/` imports from 24 of
those directories, `workflows/` from 21; 21 directories import `lib/`, 22
import `db/`, and 16 import `env.ts` directly. The heaviest edges are
`routes->lib` 215, `workflows->lib` 183, `workflows->sandbox` 149; the
heaviest cycles are `workflow-definition<->workflows` 28/38,
`sandbox<->workflows` 7/149 and `lib<->workflows` 8/183.

There is no service layer: `lib/` is the domain (audit section 3.5). A block
type is declared in eight places, and adding one touched 24 files in 8
directories (audit section 3.1, commit `9b52286f`). Nothing checks the
direction of an import: the worker has no linter and no boundary tool (audit
section 6).

The cost is not the cycle count itself. It is that "where does this file go
and what may it import" has no answer inside the repository, so every new file
picks a directory by resemblance, and every gate proposed to fix that has
nothing to reference. A boundary rule needs a destination for every directory
that exists today, or the ratchet to zero never terminates.

## Decision

Three parts: a tier per directory, a fixed set of allowed edges between tiers,
and a destination for all 28 directories and all 8 root files.

### Tiers

| Tier | What lives there |
|---|---|
| `app` | the server surface: HTTP routes, middleware, plugins, MCP tools and auth wiring |
| `services` | use cases the surface calls; one cluster per domain, `index.ts` as the cluster interface |
| `engine` | the workflow runtime: the `"use workflow"` body, the `"use step"` functions, blocks, definition handling |
| `adapters` | outbound integrations behind an interface (VCS, issue tracker, messaging) |
| `db` | schema, client, repositories; the only tier that knows the driver |
| `config` | environment access and derived configuration |
| `infra` | cross-cutting mechanics with no domain knowledge (logging, telemetry, crypto, provider clients) |
| `testing` | fixtures, harnesses and colocated tests |
| `packages/*` | pure code with two consumers, outside `apps/worker/src` |

### Allowed edges

Top to bottom:

```
app        -> services, engine (the workflow entrypoint only), packages, config
services   -> engine, adapters, db, packages, infra
engine     -> adapters, db, packages, infra
adapters   -> packages, infra
db         -> packages/contracts, infra
config     -> nothing
infra      -> nothing
testing    -> anything; imported by nothing outside tests
packages/* -> packages/contracts (workflow-graph may also use conditions;
              harness may use skills)
```

No upward edge, no sideways edge except those listed. `env` is imported only
by `config`. `db/client` is imported only by `db`. Routes and MCP tools never
call `getDb()`.
The logger's direct `process.env.LOG_LEVEL` bootstrap read is the one explicit exception to config ownership.

### Packages

A package needs two consumers. `contracts`, `conditions`, `prompts`,
`harness`, `skills`, `costs` and `workflow-graph` are used by both apps and
are pure, so they become `packages/*`. Each `package.json` carries a
`description` that states what the package may and may not do; a gate fails
when one is missing. Each package exposes a curated `exports` map, one entry
per public module, not one per file.

The engine, the adapters, the services and the DB layer have one consumer (the
worker) and stay directories inside `apps/worker/src`, fenced by dependency
rules rather than by a package boundary.

### Where today's code goes

This is the D3 table with one row per top-level entry of `apps/worker/src`, so
it can be checked against `ls apps/worker/src` without reading a group. No
tier differs from D3. Every entry has exactly one destination, and the
dependency-cruiser rules of stage 1 reference this table.

The 28 directories:

| Today (`apps/worker/src/`) | Tier | Note |
|---|---|---|
| `adapters/` | adapters | `adapters/vcs`, `adapters/issue-tracker`, `adapters/messaging` are adapters; `adapters/run-registry` is db, because it is one implementation, that is, a repository |
| `approvals/` | services | mixed: `*-schema.ts` and `store.ts` to db (stage 7), files carrying `"use step"` to `engine/steps` (stage 5), the rest to services |
| `clarifications/` | services | mixed, split by file as above |
| `db/` | db | |
| `dispatch-queue/` | services | mixed, split by file as above |
| `harness-profiles/` | engine (runtime) | `store.ts` to db in stage 7; pure parts to `packages/harness` and `packages/skills` in stage 8 |
| `lib/` | split by file | `env` accessors to config; logger, llm-provider, llm, github-webhook-sig, webhook-crypto, unique-violation, vcs-urls to infra; everything else to services. Landed in stage 6b as the clusters dispatch, run-lifecycle, tickets, publication, overview, auth, slack, email, vcs, prompts and telemetry |
| `manual-dispatch/` | services | mixed, split by file as above |
| `mcp/` | app | tools, auth, catalog |
| `mcp-dogfood/` | testing | |
| `memory/` | engine | |
| `middleware/` | app | |
| `plugins/` | app | |
| `post-pr-gate/` | engine | |
| `pre-pr-checks/` | engine | |
| `pre-sandbox/` | engine | |
| `prompt-library/` | engine (runtime) | `store.ts` to db in stage 7; pure parts to `packages/prompts` in stage 8 |
| `repository-discovery/` | services | mixed, split by file as above |
| `routes/` | app | keeps its name and path because Nitro scans it |
| `run-analysis/` | engine | |
| `run-observability/` | engine | |
| `sandbox/` | engine | |
| `schedule-trigger/` | services | mixed, split by file as above |
| `system-health/` | services | mixed, split by file as above |
| `test-support/` | testing | |
| `webhook-trigger/` | services | mixed, split by file as above |
| `workflow-definition/` | engine (`engine/definition/`) | `store.ts` to `db/repositories/definitions` in stage 7; pure schema, validation, bindings, scheduler, interpreter to `packages/workflow-graph` in stage 12 |
| `workflows/` | engine | |

The 8 root files:

| Today (`apps/worker/src/`) | Tier | Note |
|---|---|---|
| `auth.ts` | app | |
| `auth-instance.ts` | app | |
| `auth.test.ts` | testing | colocated test of `auth.ts`; stays next to its subject |
| `deployment-identity.ts` | services (`services/system`) | moved to `services/system/` in stage 6b |
| `deployment-identity.test.ts` | testing | colocated test of `deployment-identity.ts`; stays next to its subject; moved with it to `services/system/` in stage 6b |
| `nitro.d.ts` | app | |
| `preview-harness-canary.test.ts` | testing | |
| `preview-replay-canary.test.ts` | testing | |

Stage 6b has landed the services tier: `apps/worker/src/lib/` is gone,
`dispatch-queue/`, `repository-discovery/` and `system-health/` are gone, and
the five directories that still hold a stage 7 store keep their names.
[docs/architecture/overview.md](../architecture/overview.md) is the map of the
clusters that replaced them. The root now holds 6 files (`deployment-identity.ts`
and its test moved to `services/system/`), and 27 top-level directories
remain, `services/` among them.

`auth.test.ts` and `deployment-identity.test.ts` are the two entries D3 does
not name. They are assigned here by the rule D3 already applies to the two
preview canaries: a `*.test.ts` file is `testing`, may import anything, and is
imported by nothing outside tests. That is a completeness fix to the plan's
table, not a new rule.

## Consequences

**Stage 1 turns this table into a gate.** dependency-cruiser gets one rule per
allowed edge plus `no-circular`, generated against this table, and three
specific rules: `env` imported only by `config`, `db/client` imported only by
`db`, no `getDb()` in `routes/` or `mcp/`. Today's violations are recorded as
a baseline keyed by tier pair (`services->app: 4`), never by file path, so
moving a file cannot reset the count; the cycle rows of that baseline sum to
the audited 28. Every later stage attaches the before and after tier-pair
table, and "the baseline got smaller" is the difference between them. Stage 11
drives the baseline to zero and deletes it, which terminates only because
every directory in the table above has a tier.

**Nothing moves in this stage.** The tiers are recorded before the code is
rearranged, so that the gate has something to reference and so a reviewer can
reject a misplaced file today by citing a document rather than a preference.

**What moves later.** Stage 5 splits `workflows/agent.ts` into
`engine/agent-workflow.ts` and `engine/steps/*.ts`, and moves the `"use step"`
files out of the mixed service directories. Stage 6a creates `config/` and
`infra/`, with validation in `infra/runtime-env.ts` and VCS accessors in
`infra/vcs-config.ts`.
Stage 6b moves the `lib/` clusters and the non-store, non-step files of the
mixed directories into `services/<cluster>/`. Stage 6c makes the server
surface thin. Stage 7 creates `db/repositories/<domain>.ts`, moves the
`store.ts` and `*-schema.ts` files there, and fences transactions and
`db/client` imports. Until those stages land, this ADR describes the intended
destination, and the baseline describes the distance to it.

**Cost.** A file with a mixed role has to be split before it can move, and the
mixed directories are named above so the split is not rediscovered per stage.
The `"use step"` files carry the additional constraint that Vercel Workflow
discovers steps by file content inside the Nitro build, so their move is
guarded by the discovery tests, not by the boundary gate.

## Options considered

**The engine as a workspace package.** Rejected (assumption A2). Vercel
Workflow discovers step files by content inside the Nitro build; a step file
inside another package is discovered only if its directory is listed in the
`dirs` option, whose glob and escape semantics no primary source documents. A
fenced directory inside `srcDir` with `engine/index.ts` as its only public
export behaves like a package and needs none of that.

**`no-circular` alone, with no tiers.** Rejected. A cycle count says two
directories point at each other but not which direction is wrong, so a fix can
reverse a cycle instead of removing it, and the ratchet has no end state. A
tier per directory gives every cycle exactly one legal direction and gives
stage 11 a termination condition.

**Packages for the engine, the services and the DB layer as well.** Rejected
by D2: each has one consumer. A package boundary there costs a build step, an
`exports` map and a version story, and buys a fence that dependency-cruiser
already provides inside one app.
