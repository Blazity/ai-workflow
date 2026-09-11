Status: current
Last-verified: 2026-09-10

# Architecture restructure: layers, packages, gates, docs

Status: APPROVED by the owner on 2026-09-09, revision 6 (owner decisions of 2026-09-10: stage order, gate policy, DB fallback, package layout, and production-count corrections; skeptic pre-mortem, roadmap and backlog fit, v1 retirement folded in as stage 3b with its own pre-mortem, and the WDK step identity and drain rule added). Owner answered Q1-Q8 and reversed Q4 the same day. Ready for `/opus-orchestration`. Not started. Jira tickets per stage: see `2026-09-09-architecture-restructure-tickets.md` beside this file.
Start SHA: `687a6bbb040b5a4baa1d8018cfe1a8d9ebb4db43` (main, 2026-09-09).
Evidence base:
[../research/2026-09-09-architecture-audit.md](../research/2026-09-09-architecture-audit.md)
(every number and `file:line` below is cited there),
[../research/2026-09-09-agent-navigable-codebase.md](../research/2026-09-09-agent-navigable-codebase.md),
[../research/2026-09-09-monorepo-boundary-enforcement.md](../research/2026-09-09-monorepo-boundary-enforcement.md),
[../research/2026-09-09-roadmap-backlog-fit.md](../research/2026-09-09-roadmap-backlog-fit.md)
(the 27 Aug roadmap and the 100 open AIW issues against this plan).

Execution: `/opus-orchestration` takes the stage table below as input. This
plan writes no production code.

## Problem

An engineer or an agent who wants to add a feature today cannot answer "where
does this go, what may it import, and what proves I broke nothing" from the
repository. Adding one block type touches 24 files in 8 directories. The
worker's 28 top-level directories have 28 two-way import cycles. Four concepts
(prompts, skills, harness profiles, costs) each have two to four competing
definitions, and the model catalog alone lives in four files. Two definition
schema versions are live, with two graph walkers and about thirty
`schemaVersion` branches, although nothing creates a v1 definition any more.
The 153
documents include about 110 dated journals and no navigable path to any
decision. Nothing blocks a regression at merge time: `main` has no branch
protection, the worker has no linter, no tool checks import boundaries, and
357 files outside `db/` write to the database directly.

## Solution

After this plan, the repository has fenced tiers inside the worker (`app`,
`services`, `engine`, `adapters`, `db`, `config`, `infra`, `testing`), seven
pure workspace packages under `packages/` (`contracts`, `conditions`,
`prompts`, `harness`, `skills`, `costs`, later `workflow-graph`), one owner
file per concept with a drift test proving it, a block model where one
directory per block generates registry, executor map and catalog, and a gate
ladder (boundaries, cycles, unused code, lint, formatting, generated files,
dependency consistency, resurrected paths, package contracts, doc status) that
runs in `verify:changed` and in a CI job that `main` requires, plus a
behavioural check (preview deploy and the two existing canaries) on changes to
the engine and the packages. Documentation is an index plus `architecture/`,
`adr/`, `product/`, `runbooks/`, `research/`, `archive/`, every current file
carrying a status and a last-verified date, with per-app `AGENTS.md` files
bridged to `CLAUDE.md`, so an agent starting in any directory loads only what
that directory needs. Behaviour of v2 runs does not change in any stage; the
one deliberate behaviour change is stage 3b, which retires schema v1 (D12,
A11).

## User stories

1. As an engineer adding a block, I want to create one directory and have the
   registry, executor map, params schema map, catalog and dashboard palette
   pick it up, so that a block is one PR in one place.
2. As an engineer adding a route or an MCP tool, I want a rule that tells me it
   may call a service and nothing else, and a gate that fails the PR if I break
   it, so that the server surface stops accumulating domain logic.
3. As an engineer changing the model list, I want one file to edit and a test
   that fails if any other file still lists a model id, so that the dashboard,
   the harness runtime and the definition validator agree.
4. As a reviewer, I want the PR check to be required on `main`, to include
   boundaries, cycles, unused code and lint, and to run a real workflow on a
   preview when the engine changed, so that green means something.
5. As an agent starting a session, I want a root `AGENTS.md` under 200 lines
   that routes me to the one current document per topic and keeps the four
   runtime gotchas that break production, and a per-app `AGENTS.md` that loads
   when I work in that app, so that I am neither flooded nor misled.
6. As a maintainer, I want every decision recorded as an ADR reachable in two
   hops from `README.md`, so that "why is v1 still live" has an answer.
7. As a dashboard engineer, I want prompt composition, model capabilities,
   skill manifests and cost math to come from packages shared with the
   worker, so that I stop re-implementing worker logic in `apps/dashboard/lib`.
8. As an operator, I want `SETUP.md` and the `init-*` skills to agree, so that
   whichever one I read gives the same env var names and constraints.
9. As an engineer or an agent authoring a workflow, I want exactly one
   definition schema to exist in code, storage rules and the editor, so that
   every block, validator, tool description and document describes one shape.

## Implementation decisions

Vocabulary: module, interface, seam, adapter, depth, leverage, locality, as in
the codebase-design skill.

**D1. Enforcement before structure, keyed so renames cannot hide
regressions.** The first code stage installs dependency-cruiser (tier rules
plus `no-circular`), knip and a minimal lint with today's violations recorded
as a baseline. The boundary baseline is keyed by tier pair
(`services->app: 4`), never by file path, so moving 140 files does not reset
it; every stage that regenerates a baseline attaches the before and after
tier-pair table as evidence, and a stage's "baseline smaller" claim is the
difference between those two tables.

**D2. A package needs two consumers.** `contracts`, `conditions`, `prompts`,
`harness`, `skills`, `costs` and `workflow-graph` are used by both apps and
are pure, so they become `packages/*`. Each `package.json` carries a
`description` that states what the package may and may not do; a gate fails
when one is missing. New packages in stages 8a through 8d (`prompts`,
`harness`, `costs`, `skills`) use the existing `packages/contracts` layout:
modules sit at the package root, `index.ts` is the only public entry, and
there is no `src/` directory. Each package exposes a curated `exports` map, one entry
per public module, not one per file. The engine, the adapters, the services
and the DB layer have one consumer (the worker) and stay directories inside
`apps/worker/src`, fenced by dependency rules (Assumption A2).

**D3. Worker tiers, allowed edges, and the complete mapping of today's
directories.** Allowed edges, top to bottom:

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
call `getDb()`. Every one of today's 28 directories and 8 root files has
exactly one destination; this table is ADR-001 and the dependency-cruiser
rules reference it:

| Today (`apps/worker/src/`) | Tier | Note |
|---|---|---|
| `routes/`, `middleware/`, `plugins/`, `mcp/` (tools, auth, catalog), `auth.ts`, `auth-instance.ts`, `nitro.d.ts` | app | server surface; `routes/` keeps its name and path because Nitro scans it |
| `lib/` | split by file | `env` accessors -> config; logger, telemetry except `telemetry/collect-snapshots.ts` and `telemetry/run-telemetry.ts` (deferred to stage 7), llm-provider, llm, github-webhook-sig, webhook-crypto, unique-violation, vcs-urls -> infra; everything else -> services (dispatch, run-lifecycle, tickets, publication, overview, auth, slack) |
| `approvals/`, `clarifications/`, `manual-dispatch/`, `dispatch-queue/`, `webhook-trigger/`, `schedule-trigger/`, `system-health/`, `repository-discovery/` | services | mixed directories split by file: `store.ts`, `*-store.ts` and `*-schema.ts` -> db (stage 7), files carrying `"use step"` -> engine/steps (stage 5), the rest -> services |
| `workflows/` | engine | |
| `workflow-definition/` | engine (`engine/definition/`) | `store.ts` -> db/repositories/definitions in stage 7; pure schema, validation, bindings, scheduler, interpreter -> `packages/workflow-graph` in stage 12 |
| `sandbox/`, `pre-sandbox/`, `pre-pr-checks/`, `memory/`, `run-observability/`, `run-analysis/`, `post-pr-gate/` | engine | |
| `harness-profiles/`, `prompt-library/` | engine (runtime) | `store.ts` -> db in stage 7; pure parts -> `packages/harness`, `packages/skills`, `packages/prompts` in stage 8 |
| `adapters/vcs`, `adapters/issue-tracker`, `adapters/messaging` | adapters | |
| `adapters/run-registry` | db | one implementation, it is a repository |
| `db/` | db | |
| `deployment-identity.ts` | services (`services/system`) | |
| `test-support/`, `mcp-dogfood/`, `preview-harness-canary.test.ts`, `preview-replay-canary.test.ts`, `auth.test.ts`, `deployment-identity.test.ts` | testing | stage 0 correction: the two root test files were missing from this table; ADR-001 is the source of truth for the mapping |

**D4. Blocks are self-describing modules with a pure manifest.** One directory
per block under `engine/blocks/<type>/` with two files: `manifest.ts` (type,
params schema, contract, ui hints; no runtime imports) and `execute.ts` (the
executor). A generator writes `packages/contracts/block-catalog.generated.ts`
(type union plus `BLOCK_TYPE_SPECS`, from manifests only),
`engine/definition/params.generated.ts` (params schema map, from manifests
only) and `engine/blocks/executors.generated.ts` (executor map, from
`execute.ts` files). Definition validation therefore never imports an
executor, which is what actually removes the `workflow-definition <-> workflows`
cycle rather than renaming it. The existing catalog-sync test becomes
"generated files are current" (`gen:blocks --check`), and the HTML mock stops
being a fixture.

**D5. The workflow body is a module of its own.** `agent.ts` splits into
`engine/agent-workflow.ts` (the `"use workflow"` function, body unchanged),
`engine/steps/*.ts` (the `"use step"` functions grouped as the file's own
section comments already group them), `engine/blocks/executors.generated.ts`,
and pure helpers. `engine/index.ts` is the only export the six dispatchers
import. The WDK discovery test and the step registration coverage test are the
guard on every move, and a real run on a preview deployment is the DoD of
every stage that moves engine files (D11).

The directive-count comparison uses the same command shape on both sides:
the ref side is `git grep -c -E '^\s*"use step";?\s*$' <ref> -- apps/worker/src | awk -F: '{s+=$NF} END {print s}'`, and the working-tree side is `rg -c '^\s*"use step";?\s*$' apps/worker/src --glob '*.ts' | awk -F: '{s+=$NF} END {print s}'`.

**D6. One owner per concept, one drift test each.**
`packages/harness/model-catalog.ts` owns model ids with two derived
views: `recognised` (the union of today's four lists, for parsing stored
data) and `selectable(providerContract)` (the intersection of what the
provider contract, the capability catalog and the dashboard offered before,
for pickers). `manifest.ts`, `capability-catalog.ts`,
`workflow-definition/models.ts` and the dashboard derive from it, and a test
greps the repo for model-id literals outside the owner. `packages/prompts`
owns slot, reference and variable composition; the dashboard's
`lib/prompt-library` copy is deleted and its 14 test files move with the
code. `packages/skills` owns the skill manifest schema, the lock-file format,
the validator, and one `SkillSource` interface that the GitHub and local
adapters satisfy. `packages/costs` owns one `costForUsage(provider, usage)`
function with a parity test for the Claude and Codex paths.

**D7. Repositories per domain, and transactions only inside them.**
`db/repositories/<domain>.ts` exports the allowed operations on the tables
that domain owns, starting with the three hottest tables (`workflowRuns`,
`workflowDefinitions`, `activeRuns`). A gate counts `db/client` imports
outside `db/` and ratchets from 357 down. The DB-client fence counts
production files only (tests are excluded under the ADR-001 testing tier),
uses exact module-specifier matching for `db/client`, and includes value,
type-only and dynamic imports. Stages 7 and 11 use this same definition.
AIW-335 is not merged: PR #303 is closed, the driver on `main` is still
`neon-http`, verified 2026-09-10. Stage 7 therefore runs under the
cancellation fallback: zero `db.transaction` calls anywhere in the worker and
multi-row writes as single statements. It adds the
`transactions-in-repositories` gate with its repository allowance dormant
until AIW-335 lands as its own ticket. If AIW-335 later lands, its own ticket
must prove the `node-postgres` driver contract before the dormant allowance
activates; Better Auth 1.7 still needs adapter transactions.

**D8. Gates are dependency-free Node scripts** under `scripts/gates/`, each
with a header (why, exit condition), a baseline JSON where a ratchet is
needed, a test under `scripts/ci/`, and one entry each in `verify:changed`
and `ci.yml`. Third-party tools (dependency-cruiser, knip, oxlint) are invoked
by those scripts so the ladder has one shape. Two gates exist only because of
this restructure: `no-resurrected-paths` (fails when a path a completed stage
deleted reappears, fed by a list the stage appends to) and
`package-contracts` (every `packages/*/package.json` has a `description`).

**D9. Documentation taxonomy with currency, not just reachability.**
`docs/index.md` is the only list of current documents. `docs/architecture/`
(overview, blocks, workflow-definition rewritten for v2, data-model with
table ownership, gates), `docs/adr/` (MADR, README says when to write one),
`docs/product/` (SPEC, user stories, roadmap), `docs/runbooks/`,
`docs/research/`, `docs/archive/`. Every file outside `archive/` and
`research/` carries `Status:` from a fixed enum (`current`, `draft`,
`superseded-by <path>`) and `Last-verified: YYYY-MM-DD`; the docs gate fails
on a missing header, on a `current` file older than 90 days, and on a current
file unreachable in two hops from `README.md` or `AGENTS.md`. Root `AGENTS.md`
becomes a routing table under 200 lines and keeps, verbatim, the four gotchas
that break production (neon-http has no transactions, WDK discovers steps by
content, `build` runs migrations, the 300 s invocation ceiling). Per-app
instructions are `apps/worker/AGENTS.md` and `apps/dashboard/AGENTS.md`, each
bridged by a one-line `CLAUDE.md` importing it, because this repo also runs
Codex sessions and the agents.md convention is "nearest file wins" while
Claude Code reads `CLAUDE.md`. `.claude/rules/*.md` with `paths:` frontmatter
carry Claude-only path-scoped gotchas mined from `learnings.md`. Procedures
(gate ladder, release) are skills, not docs. `SETUP.md` is the fact
reference; the `init-*` skills link to its sections and never restate a
constraint.

**D10. Freezes are tied to events, not dates, and cover what moves.** No PR
touching `apps/worker/src/workflows` merges between the start of stage 3b and
stage 5 landing on `main`; no PR touching `apps/worker/src/lib` or
`apps/worker/src/routes` merges between the start of 6a and 6c landing on
`main`. The `no-resurrected-paths` gate catches the rebase failure mode where
git recreates a moved file under its old path.

**D12. One schema version.** Stage 3b retires definition schema v1 for
everything that runs, deploys or is authored; stored history stays readable.
Deleted: the v1 graph walker (`executeGraph` in
`workflow-definition/interpreter.ts`; `buildRuntimeGraph`, `executionError`,
`formatExecutionErrorForUser` and `createWorkflowExecutionErrorState` stay
because the v2 walker uses them), every `schemaVersion === 1` branch and every
now-constant `schemaVersion === 2` guard in the workflow body, the steps, the
blocks, dispatch, definition loading, the prompt drift gates and the store,
`isV2OnlyBlockType`, the v1-to-v2 converter and migration (worker module,
migrate route, dashboard drawer), the three singular shim routes, and the
dashboard's `schemaVersion = 1` defaults and branches. Replaced, not deleted:
the fresh-install default. `buildDefault` in `definition-step.ts`, the clone
and seed fallbacks in `workflow-definitions.post.ts` and the two drift gates
take `defaultWorkflowDefinitionV2` instead of the v1 default, so a deployment
with no deployed definition runs the v2 default through the v2 walker; the v1
default is deleted only after those five consumers moved. Kept: the runtime
plan shape (`WorkflowDefinitionNode` with `params`, `LoadedWorkflowPlan`,
`toLegacyRuntimeShape`) is an internal representation the v2 walker already
consumes, not a schema version; 3b renames the function to `toRuntimeShape`
and changes nothing else about it. Types: the runnable `WorkflowDefinition`
narrows to v2 in contracts; `WorkflowDefinitionV1` stays in contracts as a
read-only stored type returned by exactly one path, the version-history read
in `store.ts:149`, whose result becomes
`{ kind: "v2", definition } | { kind: "legacy-v1", raw }`; dispatch, deploy,
rollback and MCP authoring accept only the v2 arm. History: a v1 row stays
listed with its badge, the editor removes its Restore action, and the API
refuses rollback to it with 409 and a message naming the retired schema; an
archived v1 definition stays listed as archived;
`workflow_run_observations.definition_schema_version` keeps its historical 1s
and its check constraint, so no migration ships. Harness-profile manifests
carry their own `schemaVersion` 1|2 and are not touched. MCP:
`workflows.save_draft` accepts v1 today; after 3b it returns VALIDATION_FAILED
with an issue naming the retired schema, and the tool description gains one
sentence naming 2 as the only accepted value, which is what changes the
contract hash; the dashboard clipboard rejects a v1 payload with the same
message. Enforcement: the DoD grep is a permanent gate,
`scripts/gates/single-schema-version.mjs`, registered in `verify:changed` and
`ci.yml` in the same PR, so a rebase of an in-flight dispatch or route branch
that reinstates a version branch fails CI; the deleted route files join the
resurrected-paths list. Preconditions, recorded in ADR-003: production has 0
of 9 deployed v1 definitions (`workflows.get_graph`, verified 2026-09-10),
the Arthur tenant is out of support, and the scenario harness (A14) is green
before and after. The v1 history row count is still unread and is recorded as
"unverified" rather than a number. The counts the MCP surface cannot see
(archived definitions and history rows) are measured by SQL on production at
the start of 3b and written into ADR-003; they change what users see in
history, not the design.

**D11. A behavioural gate on the engine.** Static gates observe structure,
not behaviour. Stage 5b, deferred until after stage 11 and AIW-316, makes the
existing preview canaries (`e2e/replay/preview-canary.ts`,
`e2e/harness-profiles/preview-canary.ts`) a required PR check for any change
under `apps/worker/src/engine/**`, `apps/worker/src/db/**` or `packages/**`:
deploy a preview, dispatch one run that executes at least one `"use step"` and
one WDK webhook function, and assert the replay. Until then, the two canaries
run manually against a preview deployment as part of the DoD of stages 5 and
6.

## Seams and test decisions

| Seam | Observed behaviour | Prior art (`file:line`) |
|---|---|---|
| Block manifest | a block directory alone makes the type valid in a definition, executable in a run, visible in the catalog; validation never loads an executor | `workflows/blocks/*.ts` export `paramsSchema`; `agent.ts:530` `BLOCK_EXECUTORS`; `block-catalog-sync.test.ts`, `block-registry.test.ts`, `schema.test.ts` |
| WDK step discovery | every `"use step"`/`"use workflow"` file is discovered by the builder and a real run executes on a preview | `workflows/workflow-import-boundary.test.ts:55-70`, `step-registration-coverage.test.ts`, `e2e/replay/preview-canary.ts`, `e2e/harness-profiles/preview-canary.ts` |
| Engine entrypoint | dispatchers start a run through one import | six import sites of `agentWorkflow` (`lib/dispatch.ts:27`, `lib/dispatch-trigger.ts:15`, `approvals/dispatch.ts:7`, `schedule-trigger/dispatch-schedule-trigger.ts:9`, `webhook-trigger/dispatch-webhook-trigger.ts:6`, `manual-dispatch/service.ts:16`) |
| Import boundaries | a forbidden tier edge fails the gate; the tier-pair baseline only shrinks | `scripts/ci/verify-changed.ts` and its test (gate-as-script pattern) |
| DB repository | a domain's tables are written only through its repository; transactions only inside repositories | `db/queries/*` (4 files, 37 functions); `db/client.ts`, `db/test-db.ts` |
| Adapters | VCS, agent runtime, messaging behind one interface each, with a fake | `adapters/vcs/types.ts`, `sandbox/agents/types.ts`, `adapters/messaging/noop.ts:8` |
| Prompt composition | slots, references and variables resolve identically in worker and dashboard | `apps/dashboard/lib/prompt-library/*.test.ts` (14 files), `prompt-library/builtin-prompt-drift-gate.ts` |
| Model catalog | one list of model ids; pickers offer the intersection, parsers accept the union | NEW seam (today four lists); its product-visible half is Assumption A6 and question Q7 |
| Skill source | GitHub-sourced and local skills are read through one interface, validated by one schema | `harness-profiles/skill-artifact.ts`, `scripts/validate-local-skills.ts`, `skills-lock.json` |
| Cost function | one number for one usage record regardless of provider | `sandbox/usage.ts`, `sandbox/agents/pricing.ts`, `workflows/run-budget.ts` |
| Docs routing | an agent reaches the current document for any topic in two hops, and the document says when it was last true | `CLAUDE.md -> @AGENTS.md -> docs/delivery-gates.md` (the one working chain today) |
| Single schema version | a stored definition is valid, deployable, dispatchable and authorable only as v2; a stored v1 version is listed but not restorable; the runtime plan shape is internal and not a schema version | `workflow-definition/schema.ts` (both parsers), `store.ts:1243,1407` (per-version validation on rollback and deploy), `workflows/agent.ts:7809` (walker choice), `v2-migration.test.ts`, `routes/api/v1/workflow-definitions.test.ts:2280` (shim tests) |

## Out of scope

* Rewriting the engine, the adapters or the block executors. They keep their
  behaviour and most of their code.
* Extracting `workflow-graph` as a package and making dashboard block forms
  schema-driven. Listed as stage 12; it gets its own plan and
  `/opus-orchestration` may stop before it.
* Turborepo, graphify, a full oxlint/tsgolint/knip adoption as a package deal.
  Only the ideas transfer (audit section 8).
* Any change to Jira, Slack, GitHub or GitLab behaviour, and any migration.

## Assumptions

Uncertainties with the recommendation adopted. Items marked (Q) were put to
the owner on 2026-09-09; the owner's answer is recorded inline.

* **A1 (Q1, owner: yes, no standing bypass). Branch protection on `main`
  requiring the `ci` job is switched on in stage 0, with no standing admin
  bypass.** The repo records "no branch
  protection, by decision". Adopted: require `ci`; bypass only through
  GitHub's "allow specified actors" for one named account, and every use
  opens a Jira issue, mirroring the `--no-verify` audit rule in `AGENTS.md`.
  The aggregator must be made reportable first (stage 0 DoD), or the bypass
  becomes the default path within a week. This is the open remainder of
  AIW-313: PR #358 already merged the credential-free bundle and the
  validators into CI, the ticket is in verification, and the flip is what is
  left.
* **A2 (Q2, owner: "whatever is cleanest", decided: fenced directory). The
  engine stays a fenced directory inside `apps/worker/src`, not a workspace
  package, with `engine/index.ts` as its only public interface, so it behaves
  like a package without fighting WDK discovery.** Adopted because Vercel Workflow discovers step
  files by content inside the Nitro build and the repo's own boundary test
  exists precisely because that discovery fails silently. The research
  settled this as a choice, not a hard constraint: `workflow/nitro` roots
  discovery at Nitro's `workspaceDir` (the pnpm root) so sibling packages may
  be imported, but a step file inside another package is discovered only if
  its directory is listed in the `dirs` option, whose glob and escape
  semantics no primary source documents. A fenced directory inside `srcDir`
  needs none of that, so the default holds.
* **A3 (Q3, owner: yes). `packages/*` are consumed as source, removing
  `build:shared` from every script, only if a spike at the start of stage 3 shows the Vercel
  tracer bundles workspace `.ts` sources into every `.func`.** The research
  did not settle this: Node's `exports` map is what gates access at runtime
  and this repo already mixes source typechecking with `dist` resolution,
  which is why every script runs `build:shared` first. If the spike fails,
  keep `dist` with TypeScript project references in the same stage. Either way the worker `tsconfig.json` stops
  including `../shared/contracts/**/*.ts` as its own source, and either way
  stage 3's DoD includes a real run on a preview (the `zod/v3` incident is
  the precedent for "local green, Vercel broken").
* **A4. Package names stay `@shared/contracts` and `@shared/conditions` in
  stage 3.** Renaming to `@ai-workflow/*` is a mechanical sweep across
  roughly 280 import sites and can happen later without moving files again.
* **A5. Lint is oxlint with `correctness` at deny and everything else at
  warn with a counted baseline; import boundaries come from
  dependency-cruiser, not from a lint plugin.** Confirmed by the research:
  oxlint implements `import/no-cycle` and `no-restricted-imports` but has no
  architecture or boundaries rule; dependency-cruiser is the only compared
  tool with a native baseline mechanism (`--baseline`, `--ignore-known`),
  which is path-keyed, so the stage 1 wrapper aggregates its JSON output by
  tier pair instead of using `--ignore-known` directly. pnpm's default strict
  linking blocks phantom dependencies only and does nothing against a relative
  `../../other/src/x` import, which is exactly the edge the cruiser rules
  close.
* **A6 (Q7, owner: "as you see fit", decided: intersection). Pickers offer
  the intersection of today's model lists; parsers accept the union.** The four lists are not four copies of one
  fact, so unifying them can widen what a user may select. Adopted: no model
  becomes selectable that was not selectable before; stage 8b's first commit
  is the four-column comparison table, and any model the owner wants newly
  exposed is a one-line change to `selectable()` after the fact.
* **A7. Journals are archived, not deleted.** `git mv` to `docs/archive/`
  keeps history and links. Deleted outright: `.agents/skills/` (vendored,
  unreferenced since 2026-05-28), `.kimi-code/` (untracked, diverged),
  `docs/workflow-workspace/index.html` (replaced by the generated catalog).
* **A8 (Q5, owner: yes). Two event-tied freezes are acceptable**: `apps/worker/src/workflows`
  from the start of stage 3b until stage 5 is on `main`; `apps/worker/src/lib`
  and `apps/worker/src/routes` from the start of 6a until 6c is on `main`.
  Each is expected to last two to four working days if the stages are
  executed back to back. Without them the moves conflict with everything in
  flight and rebases resurrect deleted paths.
* **A9. The GitLab numeric-id contradiction is resolved against the code,
  not by asking or by a live call.** `lib/vcs-urls.ts:4` builds the sandbox
  clone URL from the project path, so numeric ids cannot work regardless of
  what a customer's instance accepts: `init-vcs/SKILL.md:61` is wrong and
  gets corrected in stage 2. `GITLAB_HOST` is real (`env.ts:49`), so
  `SETUP.md` gains it in the same stage.
* **A10. `.claude/learnings.md` content is mined into `.claude/rules/*.md`
  with `paths:` frontmatter and the file itself is archived**, except the
  four production gotchas, which stay in root `AGENTS.md` (D9). It is loaded
  by nothing today.
* **A11 (Q4, owner first said "separate", then reversed it on 2026-09-09:
  v1 is retired inside this plan as stage 3b).** Owner's reason: no customer
  runs v1 (the Arthur tenant is out of support) and two live schemas create
  chaos for people and agents. Evidence: nothing creates v1 any more
  (definition POST and templates emit v2; only the three singular shim routes
  still serve the v1 default and only their own tests call them); production
  has 0 of 9 deployed v1 definitions (`workflows.get_graph`, verified
  2026-09-10); the v1 history row count is still unread and is recorded as
  "unverified" rather than a number; the eight scenario snapshots are v2.
  ADR-003 is therefore written as Accepted in stage 2 and
  stage 3b executes it; stage 12 loses its condition. This is the plan's only
  deliberate behaviour change and D12 fences it.
* **A12 (Q6, owner: "as you see fit", decided: yes). The behavioural gate
  (5b) costs one preview deploy and one LLM-backed run per PR that touches the engine, the DB layer or the
  packages.** Adopted because no static gate observes behaviour and nightly
  e2e runs against a different SHA than the one being merged. Scope is
  narrowed to those paths so a docs or dashboard PR never pays for it.

* **A13. AIW-335 is not merged as of 2026-09-10.** PR #303 is closed and
  `main` still uses `neon-http`, verified 2026-09-10. Stage 7 runs under the
  cancellation fallback: zero `db.transaction` calls anywhere in the worker,
  multi-row writes as single statements, and a `transactions-in-repositories`
  gate whose repository allowance stays dormant until AIW-335 lands as its own
  ticket. That ticket must prove the `node-postgres` driver contract before the
  allowance activates; Better Auth 1.7 still needs adapter transactions. Open
  risk owned by AIW-335, not by this plan: `neon-http` was chosen in 2026-07
  because the DB client must load inside WDK step bundles where a socket pool
  could not run; AIW-335 must prove a `pg` pool works there.
* **A14 (Q8, owner: yes). AIW-195 and AIW-197 (strict template scenario
  harness) are pulled forward and land before stage 4.** They give stages 4
  and 5 a behavioural net beyond unit tests and one preview run. Cost: two
  Backlog tickets move ahead of feature work. The eight scenario snapshots
  under `workflow-definition/scenarios/snapshots/` are all `schemaVersion: 2`,
  so the harness guards v2 behaviour only.

### Step identity and the drain rule

The Vercel Workflow DevKit identifies a step by its module path plus its
function name. The id has the shape
`step//<relative module path>//<functionName>` (`@workflow/core/dist/step.js:169-176`).
The path aliasing in `@workflow/core/dist/private.js:9-80` only rewrites
`./workflows/`, `./example/workflows/` and `./src/workflows/` prefixes. A
suspended run stores those ids in its event log. After a deploy that moved or
renamed a `"use step"` or `"use workflow"` function, replay of such a run
fails with `StepNotRegisteredError`
(`@workflow/core/dist/runtime/step-handler.js:203-208`) when the old id no
longer exists, or with `ReplayDivergenceError`
(`@workflow/core/dist/step.js:62-67`) when the sequence of step calls changed.
Nothing at build time catches this.

For this restructure, every stage that moves an engine file or renames a step
function, including stages 4, 5, 6a, 6b and 6c in this plan, and any later
stage that touches `apps/worker/src/workflows`, merges only after the drain
protocol below has run on production.
For stage 6b, drain only when the identity manifest shows a path change for a
directive-bearing file.

#### Drain protocol before a step-moving deploy (stages 4, 5, 6)

Reason: WDK step identity is path plus function name; a suspended run cannot
resume after its steps move.

Operational facts (recon 2026-09-09): there is no env pause flag or cron
toggle. The only switch is the per-definition `enabled` flag
(`workflowDefinitions.enabled`, `schema.ts:58`) set through MCP
`workflows.set_enabled`. It stops AI-column dispatch, webhook and schedule
triggers for that definition, but does not stop manual dispatch. Run statuses
are `running` (non-terminal), `awaiting` (parked, needs a human), and terminal
`success`, `failed`, `blocked`, `completed` and `cancelled`. Listing is
available through MCP `runs.stats` (cap 20, with a truncation flag) or
`GET /api/v1/runs` with a dashboard session. `runs.cancel` writes only
`statusReason` ("cancelled by <clientId>") and posts no Jira comment, so post
the comment yourself with MCP `tickets.comment` before cancelling an awaiting
run.

1. Announce the dispatch pause and its expected length to the team.
2. Pause dispatch: disable every enabled definition through the product MCP
   (`workflows_list`, then `workflows_set_enabled false` for each; record the
   list to re-enable).
3. Wait for zero non-terminal runs (`runs_stats` or the dashboard runs view):
   statuses running, awaiting, parked. Runs parked on a clarification: cancel
   with `runs_cancel` and a reason naming the redeploy; the Jira comment must
   tell the human to re-dispatch (move the ticket back into the AI column)
   after the deploy.
4. Merge the PR (main auto-deploys both projects); wait for `/health` to report
   the new commit.
5. Re-enable the definitions recorded in step 2; run the smoke (health,
   dashboard login page, `workflows_get_graph` sweep returns every definition).
6. Record the window and the cancelled runs in the PR as evidence.

The protocol needs the product MCP authorized for the operator running it.

The stage gate check is `no use step or use workflow function renamed, moved
or reordered` unless the drain was done.

## Backlog and roadmap fit

Detail in the fit document. Rules that bind the stage table:

* **Bugs first, freezes second.** Stages 0 to 3 (not 3b) touch none of the files the
  open High bugs touch (AIW-277, 279, 280, 292, 284, 187 live in
  `lib/dispatch*`, `clarifications/`, `workflows/agent.ts`). Bug fixes flow
  in parallel with stages 0-3. The first freeze starts only when those bugs
  are merged or the owner defers them. A High bug found during a freeze is
  fixed on the restructure branch by its executor, never on `main`.
* **AIW-293 tasks that change block contracts land after stage 4** (AIW-294,
  297, 305, 306, 300, 301); UI-only ones land any time (AIW-296, 299, 304,
  288, 290); trigger-scope ones after 6c (AIW-295, 298); memory after 7
  (AIW-303).
* **Architecture before the canary gate.** Stage 5b (the canary CI job) and
  AIW-316 are deferred until after stage 11. Until then, the two canaries run
  manually against a preview deployment as part of the DoD of stages 5 and 6.
* **The P0 stabilisation order in AIW-326 is respected**: stage 0 is its
  "G2 enforcement" step; nothing in stages 1-3 blocks AIW-316 -> 317 -> 320
  -> 318, and that sequence starts after stage 11.
* **Tickets for the stages** are created on approval, one per stage under a
  new epic, DoD copied as acceptance criteria.

## Stages

Tiers: `opus` for judgment-heavy or high-blast-radius work, `sonnet` for
well-specified moves with a strong test net, `haiku` never. File scopes are
disjoint between stages that may run in parallel; a stage that shares a file
with an earlier stage lists it under "after".

Gate policy for the remaining stages: logic stages 5, 6c and 7 get a skeptic
pre-mortem on the brief before code, then a reviewer plus skeptic gate.
Mechanical stages 4, 6a, 6b, 8a through 8d, 9, 10 and 11 get one reviewer and
one fix round. After the second round, only blockers block and majors become
follow-up tickets. The executor runs the full DoD itself before reporting.

| # | Stage | Seam | File scope | Tier | Skeptic | TDD | Delegation | DoD |
|---|-------|------|------------|------|---------|-----|------------|-----|
| 0 | Finish AIW-313 and record the decisions: ADR-001 (layering, packages, the D3 tier table), ADR-004 (gates and required CI); make the `ci` aggregator reportable (`if: always()`, explicit per-need result check, no `paths:` filter); then require `ci` on `main` per A1 and close AIW-313 with its evidence | Import boundaries | `docs/adr/README.md`, `docs/adr/ADR-001-layering-and-packages.md`, `docs/adr/ADR-004-gates-and-required-ci.md`, `.github/workflows/ci.yml` (aggregator job only), GitHub branch protection | opus (ADRs) + human (setting) | no | no | no | a throwaway docs-only PR and a PR with one shard deliberately cancelled both end in a reportable green or red on `ci`, never a permanent "expected"; `gh api repos/Blazity/ai-workflow/rulesets` lists one active branch ruleset targeting `main` and `gh api repos/Blazity/ai-workflow/rulesets/<id>` shows a single `required_status_checks` entry with `context: ci` and exactly one `bypass_actors` entry of type User (stage 0 correction: classic `branches/main/protection` stays 404 under a ruleset and proves nothing); ADR-001 lists all 28 directories and 8 root files with a tier; both ADRs Accepted |
| 1 | Gate ladder with baselines: dependency-cruiser with tier rules from ADR-001 and `no-circular`, baseline keyed by tier pair; knip baseline; oxlint minimal for both apps; `git diff --check` in CI; `no-resurrected-paths` (empty list) and `package-contracts` gates; AIW-325 folded in: the WDK bundle check distinguishes executable Node imports from import-like text in string literals and fails closed on a negative fixture, so dependency-cruiser owns directory tiers and the bundle check owns "no Node import in workflow VM code"; all wired into `verify:changed` and `ci.yml` | Import boundaries | `.dependency-cruiser.cjs`, `knip.json`, `.oxlintrc.json`, `scripts/gates/**`, `scripts/ci/verify-changed.ts`, `scripts/ci/*.test.ts`, `.github/workflows/ci.yml` (ladder steps), root `package.json`, `pnpm-lock.yaml`, `apps/worker/src/workflows/workflow-import-boundary.test.ts` and its fixtures (AIW-325); after 0 | sonnet | no | yes (a fixture with a forbidden tier edge fails; the baseline passes; a renamed file does not change the tier-pair counts) | yes (baseline capture) | `pnpm run verify:changed` exits 0 on `main`; `pnpm run test:ci` passes; the boundary baseline is a tier-pair table whose cycle rows sum to the audited 28; a test adds `app -> db/client` and the gate exits 1; a test renames a baselined file and the gate output is unchanged; `ci.yml` runs the ladder on a PR |
| 2 | Docs taxonomy and agent routing: `docs/index.md`; ADR-002 block manifest, ADR-003 v1 retirement (Accepted per A11 and D12, citing the production count), ADR-005 docs taxonomy; `git mv` journals to `docs/archive/`; `Status:` and `Last-verified:` headers on every current doc; rewrite `docs/workflow-definitions.md` -> `docs/architecture/workflow-definition.md` against the v2 files; fix README capability claims against the roadmap; correct `init-vcs/SKILL.md` and add `GITLAB_HOST` to `SETUP.md` per A9; skills link to SETUP sections; root `AGENTS.md` to a routing table under 200 lines keeping the four production gotchas; `apps/worker/AGENTS.md` + `CLAUDE.md`, `apps/dashboard/AGENTS.md` + `CLAUDE.md`; `.claude/rules/*.md` per A10; `scripts/gates/docs-status.mjs` (headers, age, reachability); delete `.agents/skills` | Docs routing | `README.md`, `AGENTS.md`, `SETUP.md`, `design-qa.md`, `docs/**` except `docs/research/` and `docs/adr/ADR-00{1,4}*`, `apps/worker/{AGENTS,CLAUDE}.md`, `apps/dashboard/{AGENTS,CLAUDE}.md`, `apps/*/docs/**`, `.claude/rules/**`, `.claude/learnings.md`, `.claude/skills/init-*/SKILL.md`, `.agents/**`, `scripts/gates/docs-status.mjs`; after 0; disjoint from 1 except the new gate file, which 1 registers and 2 fills | opus for `workflow-definition.md`, ADRs and both `AGENTS.md` roots; sonnet for moves and headers | yes (agent-facing text is behaviour) | no | yes (git mv sweep, headers) | `docs-status` gate exits 0: every current doc has both headers, none older than 90 days, all reachable in two hops; root `AGENTS.md` under 200 lines and contains the four gotchas verbatim; `rg -n 'schemaVersion' docs/architecture/workflow-definition.md` shows v2; the six audited contradictions each have a commit that closes them; `pnpm run verify:changed` exits 0 |
| 3 | `packages/` directory: opens with the A3 spike on a preview (source consumption, canaries), then move `apps/shared/contracts` -> `packages/contracts`, `apps/shared/conditions` -> `packages/conditions`; curated `exports` maps; `description` per package; source consumption per A3 or project references; drop `build:shared` if A3 holds; remove the worker tsconfig include of shared sources; `packages/AGENTS.md`; pnpm catalog for deps both apps share plus `check-deps-consistency` gate | Import boundaries | `apps/shared/**`, `packages/**`, `pnpm-workspace.yaml`, `apps/worker/tsconfig.json`, `apps/dashboard/tsconfig.json`, `apps/worker/package.json`, `apps/dashboard/package.json`, `apps/worker/nitro.config.ts`, `apps/dashboard/next.config.ts`, `scripts/gates/check-deps-consistency.mjs`; after 1 | opus | no | no | no | `pnpm typecheck`; `pnpm --filter worker exec vitest run src/workflows/workflow-import-boundary.test.ts`; `pnpm --filter worker build:ci`; `pnpm --filter ai-workflow-dashboard build`; `package-contracts` gate passes; a preview deploy of the worker answers `/health` AND `pnpm run test:e2e:replay` and `pnpm run test:e2e:harness-profiles` (the non-dry canaries) pass against that preview, executing at least one step and one WDK webhook function; boundary tier-pair table unchanged or smaller (attached) |
| 3b | Retire schema v1 (D12, A11): measure archived and history v1 rows by SQL on production at the start of 3b and hand the counts to ADR-003, with the v1 history row count recorded as "unverified" until read; switch the five consumers of the v1 default (`definition-step.ts` `buildDefault`, clone and seed fallbacks in `workflow-definitions.post.ts`, `builtin-prompt-drift.ts`, `carry-schema-drift.ts`) to `defaultWorkflowDefinitionV2`, then delete the v1 default; delete `executeGraph` and its private helpers; collapse every `schemaVersion === 1` branch and every constant `=== 2` guard in `workflows/agent.ts`, `workflows/definition-step.ts`, `workflows/prompt-references-step.ts`, `workflows/blocks/{fix-agent,prepare-workspace,types,test-support}.ts`, `lib/dispatch.ts`, `lib/dispatch-trigger.ts`, `workflow-definition/{store,harness-profile-runtime,layout,graph-fixtures}.ts`, `prompt-library/builtin-prompt-drift.ts` to the v2 arm; rename `toLegacyRuntimeShape` to `toRuntimeShape`; delete `isV2OnlyBlockType`, the three singular shim routes, `v2-converter.ts`, `v2-migration*.ts`, `[id]/migrate.post.ts` and the dashboard migration drawer; narrow the runnable `WorkflowDefinition` to v2 and make the history read return the `v2 | legacy-v1` result of D12; rollback to a v1 version returns 409 with the retired-schema message; editor hides Restore on v1 rows; clipboard rejects v1; `save_draft` description sentence and regenerated `mcp-contract.json`; remove dashboard `schemaVersion = 1` defaults and branches; new gate `scripts/gates/single-schema-version.mjs` registered in `verify:changed` and `ci.yml`; shim and migrate route paths appended to the resurrected-paths list; v1 cases dropped from the 18 worker and 8 dashboard test files | Single schema version | `apps/worker/src/workflow-definition/{interpreter,schema,validation,store,default,templates,v2-converter,v2-migration,v2-migration-prompts,v2-migration-harness-profiles,harness-profile-runtime,layout,graph-fixtures}.ts`, `apps/worker/src/workflows/{agent,definition-step,prompt-references-step}.ts` (version branches only), `apps/worker/src/workflows/blocks/{fix-agent,prepare-workspace,types,test-support}.ts` (version branches only), `apps/worker/src/lib/{dispatch,dispatch-trigger}.ts` (three lookups only), `apps/worker/src/prompt-library/builtin-prompt-drift.ts`, `apps/worker/src/routes/api/v1/workflow-definitions.post.ts`, `apps/worker/src/routes/api/v1/workflow-definition.{get,put}.ts`, `apps/worker/src/routes/api/v1/workflow-definition/restore.post.ts`, `apps/worker/src/routes/api/v1/workflow-definitions/[id]/migrate.post.ts`, `apps/worker/src/mcp/tool-catalog.ts` (one description sentence), `apps/worker/src/mcp/contracts/mcp-contract.json`, `packages/contracts/{domain,workflow-graph}.ts`, `apps/dashboard/lib/{flows.ts,workflow-editor/**}`, `apps/dashboard/components/cockpit/screens/workflow-editor.tsx`, `apps/dashboard/components/cockpit/flow-editor/**` (except `agent-harness-profile.tsx`), `scripts/gates/single-schema-version.mjs`, `scripts/gates/no-resurrected-paths.json`, `scripts/ci/verify-changed.ts` and `.github/workflows/ci.yml` (one gate entry each), the 26 test files that pin v1; after 3 and after AIW-195/197 (A14); 4 and 5 share `blocks/*`, `prompt-references-step.ts` and contracts `domain.ts` with it and list it under after; opens the first A8 freeze | opus | yes (deployability, rollback, fresh-install default and MCP authoring change) | yes (a dispatch with no deployed definition plans from `defaultWorkflowDefinitionV2` and walks through `executeV2Graph`; rollback to a stored v1 version returns 409 with the message; `workflows.save_draft` with `schemaVersion: 1` returns VALIDATION_FAILED with the message; the history read returns the `legacy-v1` arm for a stored v1 row and the editor renders it without Restore; the clipboard rejects a v1 payload; a fixture that reintroduces `schemaVersion === 1` fails the new gate; the scenario harness passes before and after, as the v2 regression floor only, since it drives `executeV2Graph` with scripted blocks and does not reach harness runtime resolution, pricing, prompt references or the failure exit, which the existing unit tests in `harness-profile-runtime.test.ts`, `planning-agent-provisioning.test.ts`, `definition-step.test.ts`, the prompt-references tests and the canaries cover) | yes (test-file trimming from the list of 26) | `node scripts/gates/single-schema-version.mjs` exits 0, its pattern is `schemaVersion (===|!==) [12]\b|schemaVersion: 1( \| 2)?\b|isV2OnlyBlockType|executeGraph\b` over `apps` and `packages` (both exist after stage 3) excluding tests, the harness-profile manifest files it lists and the single history parser, and the fixture test fails it; `pnpm typecheck`; `pnpm --filter worker exec vitest run src/workflow-definition src/workflows src/routes src/lib src/prompt-library` and `pnpm --filter ai-workflow-dashboard test` pass; `pnpm --filter worker mcp:contract:check` passes and the recorded hash differs from the start-SHA hash; `pnpm --filter worker run db:generate` produces no migration; the reviewer attaches a table of every collapsed version site (6 `=== 1` and 13 `=== 2` in `agent.ts` at the start SHA, 2 in the store, 3 in dispatch, the rest per file) showing the v2 arm kept verbatim; preview deploy plus both non-dry canaries pass; a `workflows.get_graph` sweep on production after deploy confirms 0 of 9 deployed v1 definitions; ADR-003 records the v1 history row count as "unverified" until read |
| 4 | Block manifest and generator: `engine/blocks/<type>/{manifest,execute}.ts` per block (move, not rewrite); `scripts/gates/generate-block-catalog.ts` writing the three generated files of D4; `schema.ts:35-50` and `block-registry.ts` consume `params.generated.ts`; `block-catalog-sync.test.ts` becomes `gen:blocks --check`; delete `docs/workflow-workspace/index.html`; dashboard palette reads `BLOCK_TYPE_SPECS` from the generated file (forms untouched); `docs/architecture/blocks.md` | Block manifest | `apps/worker/src/workflows/blocks/**`, `apps/worker/src/engine/blocks/**` (new), `apps/worker/src/workflow-definition/{block-registry,schema}.ts` (import sections), the `BLOCK_EXECUTORS` section of `apps/worker/src/workflows/agent.ts` only (lines 461-566 at the start SHA, renumbered by 3b), `packages/contracts/{domain,workflow-graph}.ts`, `packages/contracts/block-catalog.generated.ts`, `scripts/gates/generate-block-catalog.ts`, root `package.json` (`gen:blocks` script), `docs/workflow-workspace/**`, `docs/architecture/blocks.md`; after 3b (shares `blocks/*` and contracts `domain.ts` with it); inside the first A8 freeze | opus | no | yes (A14: AIW-195/197 scenarios land first and run on every commit; generator: fixture block dir -> expected three outputs; a manifest that imports a runtime module fails generation; existing registry, schema and catalog tests are the regression net) | yes (moving 26 block files into directories) | `pnpm --filter worker exec vitest run src/workflow-definition src/engine/blocks` passes; `gen:blocks --check` fails after editing a manifest and passes after `pnpm run gen:blocks`; `pnpm --filter ai-workflow-dashboard build` and `pnpm --filter ai-workflow-dashboard test` pass from a fresh checkout without a manual generation step (the check runs in `build`); the attached tier-pair table shows zero `engine/definition -> engine/blocks/*/execute` edges and the `definition <-> blocks` cycle row at 0; `docs/architecture/blocks.md` walks through adding a block in one directory and a reviewer follows it on a throwaway block that is then deleted; merge after drain (Step identity and the drain rule) |
| 5 | Split `agent.ts` into `engine/agent-workflow.ts`, `engine/steps/*.ts`, pure helpers; `engine/index.ts` exports `agentWorkflow`; the six dispatchers import from `engine/index.ts`; `"use step"` files in the mixed service directories (D3 table) move to `engine/steps/` in the same PR; append `apps/worker/src/workflows` to the resurrected-paths list | WDK step discovery, Engine entrypoint | `apps/worker/src/workflows/**`, `apps/worker/src/engine/**`, `"use step"` files under `approvals/`, `clarifications/`, `manual-dispatch/`, `webhook-trigger/`, `schedule-trigger/`, `pre-sandbox/`, `pre-pr-checks/`, `sandbox/`, `workflow-definition/` (move only), the six dispatcher import lines, `scripts/gates/no-resurrected-paths.json`; after 4; inside the first A8 freeze | opus | yes (the run state machine lives here) | no (pure move; the existing tests in `workflows/` (79 files at the start SHA, fewer after 3b) plus the two discovery tests are the net) | no | `workflow-import-boundary.test.ts` and `step-registration-coverage.test.ts` pass; `pnpm --filter worker exec vitest run src/engine` passes; reviewer confirms with `git diff --color-moved=dimmed-zebra` that the workflow body moved with zero logic edits, recorded in the PR as the before and after SHA of the function; the two canaries (`e2e/replay/preview-canary.ts`, `e2e/harness-profiles/preview-canary.ts`) run manually against a preview deployment and both pass until 5b lands; `rg -l '"use step"' apps/worker/src --glob '!src/engine/**'` is empty; tier-pair table shows `lib <-> workflows` and `sandbox <-> workflows` rows at 0; merge after drain (Step identity and the drain rule) |
| 5b | Behavioural PR gate (D11, A12; deferred until after stage 11 and AIW-316; delivers the live-canary half of AIW-199 and the production-dispatch mode of AIW-196): a CI job that, for PRs touching `apps/worker/src/engine/**`, `apps/worker/src/db/**` or `packages/**`, deploys a preview and runs both non-dry canaries; stage 11 creates `docs/architecture/gates.md` with the complete ladder and no baseline column if it does not exist, and this stage adds the canary row; the job joins the `ci` aggregator's needs | WDK step discovery | `.github/workflows/ci.yml` (new job), `e2e/replay/preview-canary.ts`, `e2e/harness-profiles/preview-canary.ts` (CI-mode flags only), `docs/architecture/gates.md`; after 11 and after AIW-316 | sonnet | no | no | no | a PR that edits one step body triggers the job and it passes; a PR that only edits `docs/` does not trigger it and `ci` still reports; a PR that deliberately renames a step function without re-registering it fails the job with the "not registered" message visible in the log |
| 6a | `config/` and `infra/`: move environment validation to `infra/runtime-env.ts` and VCS configuration to `infra/vcs-config.ts`; move the infra modules named in the D3 table to `infra/`, except the DB-coupled telemetry modules `lib/telemetry/collect-snapshots.ts` and `lib/telemetry/run-telemetry.ts`, which are deferred to stage 7; every other `env` import replaced by a parameter or a settings accessor | Import boundaries | `apps/worker/src/infra/**`, the infra files listed in D3 except `apps/worker/src/lib/telemetry/collect-snapshots.ts` and `apps/worker/src/lib/telemetry/run-telemetry.ts`, every file whose only change is an `env` import line; after 5; inside the second A8 freeze | sonnet | no | no | yes (import sweep) | `rg -l 'from ".*runtime-env\.js"' apps/worker/src --glob '!src/infra/**'` is empty; `pnpm typecheck`; `pnpm --filter worker exec vitest run src/infra` passes; the two canaries run manually against a preview deployment and pass; tier-pair table attached and smaller; merge after drain (Step identity and the drain rule) |
| 6b | `services/`: the seven `lib/` clusters named in D3 (dispatch, run-lifecycle, tickets, publication, overview, auth, slack) and the mixed service directories of D3 move into `services/<cluster>/` with an `index.ts` per cluster as its interface; add `services/vcs`, `services/email` and `services/prompts` as three additional clusters; every `store.ts`, `*-store.ts` and `*-schema.ts` stays in place for stage 7, so no file is moved twice; append `apps/worker/src/lib` and each moved directory to the resurrected-paths list | Import boundaries | `apps/worker/src/lib/**` (not moved in 6a), `apps/worker/src/services/**`, `apps/worker/src/{approvals,clarifications,manual-dispatch,dispatch-queue,webhook-trigger,schedule-trigger,system-health,repository-discovery}/**` (non-store, non-*-store, non-*-schema, non-step files), `apps/worker/src/deployment-identity.ts`, `scripts/gates/no-resurrected-paths.json`; after 6a; inside the second A8 freeze | sonnet | no | no | yes (cluster moves from the audit's inventory) | `apps/worker/src/lib` no longer exists and `no-resurrected-paths` lists it; `pnpm typecheck`; `pnpm --filter worker exec vitest run src/services` passes; the two canaries run manually against a preview deployment and pass; tier-pair table attached and smaller; `docs/architecture/overview.md` lists the clusters with one-sentence contracts; drain only when the identity manifest shows a path change for a directive-bearing file |
| 6c | Server surface becomes thin: the three audited handlers (`webhooks/jira.post.ts`, `cron/poll.get.ts`, `webhooks/custom/[endpointId].post.ts`) and the MCP tools move their branching into services; no route or MCP tool imports `db/client` or `env`; every POST validates with a `@shared/contracts` schema (fixes `invites.post.ts` and `webhooks/resend.post.ts`); `routes/` keeps its path and name | Import boundaries | `apps/worker/src/routes/**`, `apps/worker/src/mcp/**`, `apps/worker/src/middleware/**`, `apps/worker/src/plugins/**`, `apps/worker/src/auth*.ts`, new service files under `apps/worker/src/services/{triggers,polling,custom-webhooks,mcp}/`; after 6b; inside the second A8 freeze | opus (permissions and webhook verification live here) | yes (webhook auth, rate limit, revocation) | yes for the extracted services (existing route tests become service tests) | no | `rg -l 'getDb\(|from ".*db/client' apps/worker/src/routes apps/worker/src/mcp` is empty; `rg -l 'readBody<' apps/worker/src/routes` is empty; `pnpm --filter worker exec vitest run src/routes src/mcp src/services` passes; `workflow-import-boundary.test.ts` passes; `pnpm --filter worker build:ci` passes; the two canaries run manually against a preview deployment and pass for stage 6 until 5b lands; merge after drain (Step identity and the drain rule) |
| 7 | DB repositories and fences (D7, cancellation fallback; AIW-335 is not merged, PR #303 is closed, and `main` still uses `neon-http`, verified 2026-09-10): `db/repositories/{runs,definitions,active-runs,auth}.ts` with the auth writes moved behind the repository and multi-row writes kept as single statements; `scripts/gates/transactions-in-repositories.mjs` (zero `db.transaction` calls anywhere in the worker under the fallback; its repository allowance is dormant until AIW-335 lands as its own ticket); `db/schema/<domain>.ts` split re-exported from `db/schema.ts`; `store.ts`, `*-store.ts` and `*-schema.ts` files from the mixed directories move under `db/`; the DB-coupled telemetry modules `lib/telemetry/collect-snapshots.ts` and `lib/telemetry/run-telemetry.ts` are absorbed with their repositories; `scripts/gates/db-client-fence.mjs` (baseline 357, ratchet); `docs/architecture/data-model.md` with the 62-table ownership table | DB repository | `apps/worker/src/db/**`, `apps/worker/src/services/auth/**` (call sites), `store.ts`, `*-store.ts` and `*-schema.ts` files of the mixed directories, `apps/worker/src/lib/telemetry/collect-snapshots.ts`, `apps/worker/src/lib/telemetry/run-telemetry.ts`, `scripts/gates/{transactions-in-repositories,db-client-fence}.mjs`, `docs/architecture/data-model.md`; the call-site migration for the three tables touches `services/**` and `engine/**`; after 6c | sonnet, with opus for the auth repository | yes (auth writes move behind a repository) | yes (gates first; the cancellation fallback checks zero transaction calls and single-statement multi-row writes; AIW-335's driver contract test is deferred to that ticket; repository functions covered by moving the existing `db/queries` tests) | yes (call-site sweep) | `pnpm --filter worker run db:generate` produces no new migration; all `*-migration.test.ts` pass; `transactions-in-repositories` gate exits 0 with zero `db.transaction` calls anywhere in the worker; multi-row writes use single statements; the repository allowance stays dormant until AIW-335 lands as its own ticket; fence baseline drops below 300 in this stage; the deferred telemetry modules are absorbed with the repositories |
| 8a | `packages/prompts`: move slot, reference, variable, composition and builtin-default logic from `packages/contracts/prompt-*.ts`, `workflow-definition/prompt-*.ts`, `lib/prompts.ts`, `engine/steps/prompt*.ts` (pure parts) and `apps/dashboard/lib/prompt-library/*` into one package; delete the dashboard copy; the drift gate moves with it | Prompt composition | `packages/prompts/**`, `packages/contracts/prompt-*.ts`, `apps/worker/src/engine/prompt-library/**`, `apps/worker/src/engine/definition/prompt-*.ts`, `apps/worker/src/engine/steps/prompt*.ts`, `apps/dashboard/lib/prompt-library/**`, `apps/dashboard/components/cockpit/prompt-editor/**` (imports only); after 7 | opus | no | yes (the 14 dashboard test files and the worker prompt tests move first and must stay green) | no | `apps/dashboard/lib/prompt-library` no longer exists and is on the resurrected-paths list; `pnpm --filter @shared/prompts test` passes; the builtin drift gate passes; a fixture prompt resolves byte-identically through worker and dashboard entry points (parity test) |
| 8b | `packages/harness`: `model-catalog.ts` with `recognised` and `selectable()` per D6, first commit is the four-column comparison table committed as `docs/adr/ADR-006-model-catalog.md`; `manifest.ts`, `capability-catalog.ts`, `workflow-definition/models.ts` and `apps/dashboard/lib/harness-profiles/*` derive from it; drift test greps for model-id literals outside the owner | Model catalog | `packages/harness/**`, `packages/contracts/harness-profiles.ts`, `apps/worker/src/engine/harness-profiles/**` (non-skill files), `apps/worker/src/engine/definition/models.ts`, `apps/dashboard/lib/harness-profiles/**`, `docs/adr/ADR-006-model-catalog.md`; after 7 and after 8d is merged (8d owns the skill-related manifest fields); disjoint from 8a, 8c | sonnet | no | yes (drift test first; a test asserts `selectable()` equals the pre-change picker list per provider) | no | `rg -n 'claude-(opus|sonnet|haiku|fable)-|gpt-5' apps packages --glob '!**/model-catalog.ts' --glob '!*.test.ts' --glob '!docs/**'` is empty; `pnpm run test:e2e:harness-profiles:dry` passes; the dashboard picker snapshot test is unchanged |
| 8c | `packages/costs`: price table shape, usage aggregation, `costForUsage(provider, usage)` used by Slack formatting, run budget and the dashboard cost screen; parity test for Claude `cost_usd` and Codex token pricing | Cost function | `packages/costs/**`, `apps/worker/src/engine/sandbox/{usage,agents/pricing}.ts`, `apps/worker/src/engine/run-budget.ts`, `apps/dashboard/app/cost-data.tsx`, `apps/dashboard/app/(cockpit)/cost/**`; after 7; disjoint from 8a, 8b, 8d | sonnet | no | yes (parity test first) | no | `pnpm --filter @shared/costs test` passes; a recorded usage fixture yields the same cost in worker and dashboard; Slack message snapshot tests unchanged |
| 8d | `packages/skills`: manifest schema, lock-file format, validator and `SkillSource` interface move from `harness-profiles/{github-skills,configured-github-skills,local-skills,skill-artifact}.ts` and `scripts/validate-local-skills.ts`; the GitHub and local adapters satisfy `SkillSource`; the drift gate covers both sources; `docs/architecture/skills.md` states the product-skill vs Claude-Code-skill distinction and why `skills/` sits at the repository root | Skill source | `packages/skills/**`, `apps/worker/src/engine/harness-profiles/*skill*.ts`, `apps/worker/scripts/validate-local-skills.ts`, `apps/worker/skills-lock.json`, `docs/architecture/skills.md`; after 4; parallel with 5 and 9; before 8b; disjoint from 8a, 8c | opus (two discovery paths become one interface) | no | yes (conformance test run against both adapters; a malformed manifest fails identically from both) | no | `pnpm --filter worker validate:local-skills` passes; the conformance test passes for both adapters; a GitHub-sourced skill with a hash mismatch fails the drift gate (fixture) |
| 9 | Dashboard hygiene: one API client in `lib/api/client.ts` with typed endpoints from contracts; the 29 direct `fetch(` sites go through it; `config-fields.tsx` split into `flow-editor/blocks/<type>.tsx` (mechanical, one file per `case`) | Docs routing (dashboard `AGENTS.md` gains the rule) | `apps/dashboard/lib/api/**`, `apps/dashboard/components/**`, `apps/dashboard/app/api/**`, `apps/dashboard/AGENTS.md`; after 4; before 8a, 8b, 8c and 8d; parallel with 5 and 8d | sonnet | no | no (119 existing tests, the two 2000-line render tests are the net) | yes (case-by-case split) | `rg -l 'fetch\(' apps/dashboard/components apps/dashboard/app --glob '!lib/api/**' --glob '!*.test.*'` is empty; `pnpm --filter ai-workflow-dashboard test` passes; no file under `components/` exceeds 1000 lines |
| 10 | Agent configuration alignment: `verify:changed` as a `Stop` hook in `.claude/settings.json`; gate ladder and release as skills linking to docs; final `AGENTS.md` trims; proof that per-app and path-scoped instructions actually load | Docs routing | `.claude/settings.json`, `.claude/rules/**`, `.claude/skills/**`, `AGENTS.md`, `apps/*/AGENTS.md`; after 9 | sonnet | no | no | no | a `/context` transcript from a session started at the repo root that edits one file under `apps/worker/src/services/auth` shows `apps/worker/AGENTS.md` and one `.claude/rules/*.md` loaded; root `AGENTS.md` under 200 lines; the hook fires on a test push in a throwaway branch |
| 11 | Ratchet to zero: remaining boundary violations, knip findings and `db/client` fence count driven to zero using the same production-only, exact-module-specifier definition as stage 7; baselines deleted; rules become hard; create `docs/architecture/gates.md` with the complete ladder and no baseline column if 5b has not created it. Terminates because every directory has a tier (ADR-001) | Import boundaries, DB repository | any file a baseline names; `scripts/gates/*.baseline.json`; after 10 | sonnet | no | no | yes (sweep) | all `*.baseline.json` deleted; `pnpm run verify:changed` and CI green with hard rules; `docs/architecture/gates.md` contains the complete ladder with no baseline column |
| 12 | `packages/workflow-graph`: v2 schema, validation, bindings, scheduler, interpreter, layout; dashboard forms generated from block manifests | Block manifest | `apps/worker/src/engine/definition/**`, `packages/workflow-graph/**`, `apps/dashboard/components/cockpit/flow-editor/**`; after 11 | opus | yes | yes | no | separate plan; not part of this run |

Parallelism: 1 and 2 are disjoint and may run concurrently after 0. 3 waits
for 1. 3b waits for 3 and for AIW-195/197 and opens the first freeze;
3b -> 4 -> 5 are sequential and 3b, 4 and 5 sit inside that freeze.
6a -> 6b -> 6c are sequential inside the second freeze. 7 waits for 6c. 8a,
8c and 8d may run concurrently after 7; 8d also runs in parallel with 5.
8b waits for 7 and for 8d to merge. 9 starts after 4 and before 8a through 8d; each package stage rewires its own dashboard consumers on top of 9.
10 waits for 9; 11 waits for 10; 5b follows 11 and AIW-316. Stage 12 remains
in its separate plan.

Order: 5b follows stage 11 and AIW-316; architecture stages run first and the
canary gate is added afterwards.

Revision 6 (2026-09-10): Stage 5b and AIW-316 move behind stage 11; canaries stay manual against previews for stages 5 and 6.
Gate policy, DB fallback, telemetry and store placement, package layout, stage ordering, gate ownership, production counts, and directive-count commands are updated per the owner's decisions.

## Pre-mortem

Skeptic (opus, fresh context, plan and audit only): REVISE, 8 HIGH, 2 MEDIUM.
Fate of each finding: **corrected** (design flaw, plan changed), **owner**
(product decision, asked in the handoff), **rejected** (deliberate, reason
recorded).

| # | Finding (condensed) | Fate | Where in revision 2 |
|---|---|---|---|
| 1 | Stage 7's directory rule moves the neon-http transaction bug into `db/` and calls it green | corrected, then superseded by AIW-335 | D7, stage 7: the production driver becomes transaction-capable (`node-postgres`, AIW-335); transactions legal only inside `db/repositories`, gate covers everything else, stage 7 ordered after AIW-335 |
| 2 | Stages 3, 5, 6c can be green locally and broken only on Vercel; 6c could move `srcDir` and lose all step files | corrected | D11, stage 5b; non-dry canaries in the DoD of 3 and 5; `srcDir` rename option deleted from 6c; discovery test added to 6c |
| 3 | Path-keyed baseline resets on every rename, "baseline smaller" is unfalsifiable | corrected | D1: tier-pair keyed baseline, before and after table attached per stage |
| 4 | Stage 4 renames the heaviest cycle instead of removing it; dashboard consumer untested; nobody runs the generator in a fresh checkout | corrected | D4: `manifest.ts` without runtime imports, three generated files, dashboard build and `gen:blocks --check` in the DoD, check runs inside `build` |
| 5 | `workflow-definition` had no tier; approvals and clarifications were assigned two tiers; stage 11 could not terminate | corrected | D3 table covers all 28 directories and 8 root files; mixed directories split by file; ADR-001 moved to stage 0 |
| 6 | Freeze on the wrong directories, date-based, and rebases resurrect deleted paths | corrected + owner | D10 and A8: two event-tied freezes; `no-resurrected-paths` gate; window scope is Q5 |
| 7 | Required `ci` with a non-reportable aggregator becomes permanently pending; the admin bypass becomes the default | corrected + owner | Stage 0 DoD makes the aggregator reportable first; A1 removes the standing bypass; Q1 |
| 8 | Only static gates; skills folded into harness; package contracts not adopted | corrected + owner | D11 and stage 5b (Q6); `packages/skills` as stage 8d; `package-contracts` gate in stage 1 and D2 |
| 9 | Unifying four model lists as a union widens what users can pick | corrected + owner | D6 and A6: intersection for pickers, union for parsers; ADR-006 table first; Q7 |
| 10 | Docs gate proves reachability not currency; rules and per-app files may never load; Codex reads neither | corrected | D9: `Status:` and `Last-verified:` headers with a 90-day rule; four gotchas stay in root `AGENTS.md`; per-app `AGENTS.md` bridged by `CLAUDE.md`; stage 10 DoD requires a `/context` transcript |
| n1 | A9 should be a live GitLab call, not a code read | rejected | the clone URL is built from the path by our own code (`lib/vcs-urls.ts:4`), so the instance's acceptance is irrelevant |
| n2 | Granular `exports` on every file makes every internal module public | corrected | D2: curated `exports`, one entry per public module |

### Pre-mortem of stage 3b (revision 4)

Skeptic (opus, fresh context, plan and code, stage 3b only): REVISE, 5 HIGH,
4 MEDIUM, 1 LOW. Same three fates.

| # | Finding (condensed) | Fate | Where in revision 4 |
|---|---|---|---|
| b1 | The v1 default is the live fresh-install run path (`definition-step.ts:132` `buildDefault`, `workflow-definitions.post.ts:141,224`, two drift gates), not shim filler | corrected | D12 "replaced, not deleted": five consumers move to `defaultWorkflowDefinitionV2` first; dispatch-without-definition test in 3b TDD |
| b2 | "Narrow contracts to v2" and "keep a read-only v1 parser" contradict: one read path (`store.ts:149`, `schema.ts:1384`) | corrected | D12: the runnable type narrows, `WorkflowDefinitionV1` stays as a stored type behind a `v2 \| legacy-v1` history read |
| b3 | The v2 runtime runs on the v1 data shape (`toLegacyRuntimeShape`, `node.params`) | corrected | D12: runtime plan shape is internal, kept, renamed; seam row reworded |
| b4 | Two DoD commands cannot run: `packages/` absent, root has no `db:generate` | corrected in part, rejected in part | `db:generate` filtered to the worker in 3b and 7; `packages/` exists after stage 3, which 3b follows |
| b5 | The DoD grep misses the 13 `=== 2` guards that go dead | corrected | gate pattern covers both comparisons and the `1 \| 2` type |
| b6 | Scope misses nine files and overlaps stages 4 and 5 | corrected | files added; 4 and 5 list 3b under after |
| b7 | The freeze does not cover dispatch and routes 3b edits, where the High bugs live | corrected | permanent `single-schema-version` gate plus resurrected-paths entries instead of a wider freeze |
| b8 | The A14 harness cannot see the v2 code 3b touches | corrected | D12 and the TDD column name the unit tests and canaries as the net; harness is the v2 floor only |
| b9 | A v1 history row keeps Restore and the 409 is a generic banner (`workflow-editor.tsx:1080-1103`) | corrected | 3b removes the action, shows the message; dashboard test in TDD |
| b10 | The MCP change is unobservable; the contract hash need not change | corrected | one description sentence changes the hash; VALIDATION_FAILED carries the message; clipboard covered |
