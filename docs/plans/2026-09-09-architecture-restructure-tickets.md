# Architecture restructure: Jira drafts

Status: CREATED in Jira on 2026-09-09; this file is the stage-to-ticket map.

| Stage | Jira key |
| --- | --- |
| Epic | AIW-338 |
| 0 | AIW-339 |
| 1 | AIW-340 |
| 2 | AIW-341 |
| 3 | AIW-342 |
| 3b | AIW-343 |
| 4 | AIW-344 |
| 5 | AIW-345 |
| 5b | AIW-346 |
| 6a | AIW-347 |
| 6b | AIW-348 |
| 6c | AIW-349 |
| 7 | AIW-350 |
| 8a | AIW-351 |
| 8b | AIW-352 |
| 8c | AIW-353 |
| 8d | AIW-354 |
| 9 | AIW-355 |
| 10 | AIW-356 |
| 11 | AIW-357 |

## Epic

- Jira type: Epic
- Jira key: AIW-338
- Summary: Architecture restructure 2026-09: tiers, packages, gates, docs
- Labels: architecture, restructure
- Description:

An engineer or an agent who wants to add a feature today cannot answer where it goes, what it may import, or what proves nothing broke. Adding one block type touches 24 files in 8 directories, and the worker's 28 top-level directories carry 28 two-way import cycles. Four concepts (prompts, skills, harness profiles, costs) each have two to four competing definitions, and two definition schema versions are live even though nothing creates a v1 definition any more. Nothing blocks a regression at merge time: `main` has no branch protection, the worker has no linter, no tool checks import boundaries, and 357 files outside `db/` write to the database directly.

Rules that bind every ticket:
- Enforcement before structure: stage 1 installs dependency-cruiser, knip and lint with today's violations recorded as a baseline before any files move.
- Behaviour of v2 runs does not change in any stage, except stage 3b, which deliberately retires schema v1 (the plan's only intentional behaviour change).
- Bugs first, freezes second: the open High bugs AIW-277, AIW-279, AIW-280, AIW-292, AIW-284 and AIW-187 must merge, or be deferred by the owner, before the first freeze starts; a High bug found during a freeze is fixed on the restructure branch, never on `main`.
- Two event-tied freezes: `apps/worker/src/workflows` is frozen from the start of stage 3b until stage 5 lands on `main`; `apps/worker/src/lib` and `apps/worker/src/routes` are frozen from the start of stage 6a until stage 6c lands on `main`.
- Evidence rules from AGENTS.md apply to every stage: record the branch and the exact start SHA before editing, freeze the candidate SHA before verification, and never report a result that was not actually observed.

Order and parallelism: 1 and 2 are disjoint and may run concurrently after 0. 3 waits for 1. 3b waits for 3 and for AIW-195/197 and opens the first freeze; 3b -> 4 -> 5 -> 5b are sequential and 3b, 4 and 5 sit inside that freeze. 6a -> 6b -> 6c are sequential inside the second freeze. 7 waits for 6c. 8a, 8b, 8c and 8d are mutually disjoint and may run concurrently after 7. 9 waits for all of 8. 10 and 11 close.

Later: stage 12 (`packages/workflow-graph`: v2 schema, validation, bindings, scheduler, interpreter, layout; dashboard forms generated from block manifests) is not a ticket in this epic. It is a separate plan and a separate `/opus-orchestration` run, to start after stage 11 closes.

## Tickets

### Stage 0: Finish AIW-313, ADRs, and require `ci` on `main`
- Jira type: Task
- Jira key: AIW-339
- Parent: the epic above
- Labels: architecture, restructure, stage-0
- Depends on / Related: AIW-313 (open remainder, do not duplicate); AIW-326 (this stage is its "G2 enforcement" step)
- Freeze: none
- Suggested executor: opus (ADRs) + human (branch-protection setting), skeptic no, TDD no, delegation no
- Summary: ADR-001 and ADR-004 are Accepted, the `ci` aggregator reports a real green/red on every PR, and `main` requires `ci` with no standing bypass.
- Scope:
  - Write ADR-001 (layering, packages, the D3 tier table covering all 28 directories and 8 root files)
  - Write ADR-004 (gates and required CI)
  - Make the `ci` aggregator job reportable: `if: always()`, an explicit per-need result check, no `paths:` filter
  - Require the `ci` status check on `main` per A1, with no standing admin bypass
  - Close AIW-313 with this evidence
  - Baseline fact: `main` currently has no branch protection, by decision; this stage changes that record
  - PR #358 already merged the credential-free bundle and the validators into CI; this stage is only the aggregator fix, the ADRs, and the branch-protection flip
- File scope: `docs/adr/README.md`, `docs/adr/ADR-001-layering-and-packages.md`, `docs/adr/ADR-004-gates-and-required-ci.md`, `.github/workflows/ci.yml` (aggregator job only), GitHub branch protection settings
- Acceptance criteria:
  - [ ] A throwaway docs-only PR and a PR with one shard deliberately cancelled both end in a reportable green or red on `ci`, never a permanent "expected"
  - [ ] `gh api repos/Blazity/ai-workflow/branches/main/protection` returns `required_status_checks.contexts` containing `ci` and `enforce_admins.enabled: true`
  - [ ] ADR-001 lists all 28 directories and 8 root files with a tier
  - [ ] Both ADR-001 and ADR-004 are marked Accepted
- Notes: Executes A1 (branch protection, no standing bypass). This ticket is the open remainder of AIW-313, not a duplicate: it covers the ADRs and the aggregator change; link AIW-313 for the branch-protection flip evidence.

### Stage 1: Gate ladder with tier-pair baselines (absorbs AIW-325)
- Jira type: Task
- Jira key: AIW-340
- Parent: the epic above
- Labels: architecture, restructure, stage-1
- Depends on / Related: after stage 0; absorbs AIW-325
- Freeze: none
- Suggested executor: sonnet, skeptic no, TDD yes (fixture with forbidden tier edge fails; baseline passes; a rename does not change tier-pair counts), delegation yes (baseline capture)
- Summary: dependency-cruiser enforces the ADR-001 tier rules and `no-circular` with a baseline keyed by tier pair; knip, oxlint, and two new gates (`no-resurrected-paths`, `package-contracts`) run in `verify:changed` and `ci.yml`.
- Scope:
  - Add dependency-cruiser with tier rules from ADR-001 plus `no-circular`, baseline keyed by tier pair (not file path)
  - Add a knip baseline and a minimal oxlint config for both apps
  - Add `git diff --check` to CI
  - Add `no-resurrected-paths` (starts empty) and `package-contracts` gates
  - Fold in AIW-325: the WDK bundle check distinguishes executable Node imports from import-like text in string literals and fails closed on a negative fixture; dependency-cruiser owns directory tiers, the bundle check owns "no Node import in workflow VM code"
  - Wire everything into `verify:changed` and `ci.yml`
- File scope: `.dependency-cruiser.cjs`, `knip.json`, `.oxlintrc.json`, `scripts/gates/**`, `scripts/ci/verify-changed.ts`, `scripts/ci/*.test.ts`, `.github/workflows/ci.yml` (ladder steps), root `package.json`, `pnpm-lock.yaml`, `apps/worker/src/workflows/workflow-import-boundary.test.ts` and its fixtures (AIW-325); after stage 0
- Acceptance criteria:
  - [ ] `pnpm run verify:changed` exits 0 on `main`
  - [ ] `pnpm run test:ci` passes
  - [ ] The boundary baseline is a tier-pair table whose cycle rows sum to the audited 28
  - [ ] A test that adds `app -> db/client` makes the gate exit 1
  - [ ] A test that renames a baselined file leaves the gate output unchanged
  - [ ] `ci.yml` runs the ladder on a PR
- Notes: Executes D1 (enforcement before structure, baseline keyed by tier pair) and A5 (oxlint for style, dependency-cruiser for boundaries).

### Stage 2: Docs taxonomy and agent routing
- Jira type: Task
- Jira key: AIW-341
- Parent: the epic above
- Labels: architecture, restructure, stage-2
- Depends on / Related: after stage 0; disjoint from stage 1 except the shared gate file
- Freeze: none
- Suggested executor: opus for `workflow-definition.md`, both ADRs and both root `AGENTS.md` files; sonnet for moves and headers; skeptic yes (agent-facing text is behaviour); TDD no; delegation yes (git mv sweep, headers)
- Summary: docs move into `docs/index.md` plus `architecture/`, `adr/`, `product/`, `runbooks/`, `research/`, `archive/`, every current file gets a status and last-verified header, and root plus per-app `AGENTS.md` route an agent to the right document in two hops.
- Scope:
  - Write `docs/index.md` as the only list of current documents
  - Write ADR-002 (block manifest), ADR-003 (v1 retirement, Accepted per A11/D12, citing the production count), ADR-005 (docs taxonomy)
  - `git mv` journals to `docs/archive/`; delete `.agents/skills/`, `.kimi-code/`, `docs/workflow-workspace/index.html` per A7
  - Add `Status:` and `Last-verified:` headers to every current doc
  - Rewrite `docs/workflow-definitions.md` to `docs/architecture/workflow-definition.md` against the v2 files
  - Fix README capability claims against the roadmap
  - Correct `init-vcs/SKILL.md` and add `GITLAB_HOST` to `SETUP.md` per A9
  - Trim root `AGENTS.md` to a routing table under 200 lines, keeping the four production gotchas verbatim
  - Add `apps/worker/AGENTS.md` + `CLAUDE.md`, `apps/dashboard/AGENTS.md` + `CLAUDE.md`
  - Mine `.claude/learnings.md` into `.claude/rules/*.md` with `paths:` frontmatter per A10, then archive it
  - Add `scripts/gates/docs-status.mjs` (headers, age, reachability)
- File scope: `README.md`, `AGENTS.md`, `SETUP.md`, `design-qa.md`, `docs/**` except `docs/research/` and `docs/adr/ADR-00{1,4}*`, `apps/worker/{AGENTS,CLAUDE}.md`, `apps/dashboard/{AGENTS,CLAUDE}.md`, `apps/*/docs/**`, `.claude/rules/**`, `.claude/learnings.md`, `.claude/skills/init-*/SKILL.md`, `.agents/**`, `scripts/gates/docs-status.mjs`; after stage 0
- Acceptance criteria:
  - [ ] `docs-status` gate exits 0: every current doc has both headers, none older than 90 days, all reachable in two hops
  - [ ] Root `AGENTS.md` is under 200 lines and contains the four gotchas verbatim
  - [ ] `rg -n 'schemaVersion' docs/architecture/workflow-definition.md` shows v2
  - [ ] The six audited contradictions each have a commit that closes them
  - [ ] `pnpm run verify:changed` exits 0
- Notes: Executes D9 (docs taxonomy with currency), A7 (archive not delete), A9 (GitLab clone URL fact), A10 (learnings mined into rules), and writes ADR-003 (v1 retirement), which stage 3b executes.

### Stage 3: `packages/` directory: contracts and conditions
- Jira type: Task
- Jira key: AIW-342
- Parent: the epic above
- Labels: architecture, restructure, stage-3
- Depends on / Related: after stage 1
- Freeze: none
- Suggested executor: opus, skeptic no, TDD no, delegation no
- Summary: `apps/shared/contracts` and `apps/shared/conditions` become `packages/contracts` and `packages/conditions` with curated `exports` maps, and the worker either consumes them as source (if the A3 spike holds) or via `dist` with project references.
- Scope:
  - Open with the A3 spike on a preview: does the Vercel tracer bundle workspace `.ts` sources into every `.func`?
  - Move `apps/shared/contracts` -> `packages/contracts`, `apps/shared/conditions` -> `packages/conditions`
  - Add curated `exports` maps (one entry per public module) and a `description` per package
  - Source consumption per A3, or keep `dist` with TypeScript project references if the spike fails
  - Drop `build:shared` if A3 holds; remove the worker `tsconfig.json` include of shared sources
  - Add `packages/AGENTS.md`
  - Add a pnpm catalog for dependencies both apps share, plus a `check-deps-consistency` gate
- File scope: `apps/shared/**`, `packages/**`, `pnpm-workspace.yaml`, `apps/worker/tsconfig.json`, `apps/dashboard/tsconfig.json`, `apps/worker/package.json`, `apps/dashboard/package.json`, `apps/worker/nitro.config.ts`, `apps/dashboard/next.config.ts`, `scripts/gates/check-deps-consistency.mjs`; after stage 1
- Acceptance criteria:
  - [ ] `pnpm typecheck` passes
  - [ ] `pnpm --filter worker exec vitest run src/workflows/workflow-import-boundary.test.ts` passes
  - [ ] `pnpm --filter worker build:ci` passes
  - [ ] `pnpm --filter ai-workflow-dashboard build` passes
  - [ ] `package-contracts` gate passes
  - [ ] A preview deploy of the worker answers `/health`, and `pnpm run test:e2e:replay` and `pnpm run test:e2e:harness-profiles` (the non-dry canaries) pass against that preview, executing at least one step and one WDK webhook function
  - [ ] The boundary tier-pair table is unchanged or smaller (attached to the PR)
- Notes: Executes D2 (a package needs two consumers), A3 (source-consumption spike), A4 (package names stay `@shared/*` for now).

### Stage 3b: Retire schema v1 (D12)
- Jira type: Task
- Jira key: AIW-343
- Parent: the epic above
- Labels: architecture, restructure, stage-3b
- Depends on / Related: after stage 3; waits for AIW-195 and AIW-197 (A14) to land first; opens the first freeze; stages 4 and 5 share `blocks/*`, `prompt-references-step.ts` and `contracts/domain.ts` with it and list it under "after"
- Freeze: first (workflows) - opens at the start of this stage
- Suggested executor: opus, skeptic yes (deployability, rollback, fresh-install default and MCP authoring change), TDD yes (dispatch-with-no-deployed-definition test, rollback 409 test, `save_draft` VALIDATION_FAILED test, history-read legacy-v1-arm test, clipboard-rejection test, gate fixture test), delegation yes (test-file trimming from the list of 26)
- Summary: a stored definition is valid, deployable, dispatchable and authorable only as v2; the v1 default, the v1 graph walker, the converter and migration paths, and every `schemaVersion` branch are deleted, while a stored v1 row stays listed read-only in history. This is the plan's only deliberate behaviour change.
- Scope:
  - Measure archived and history v1 rows by SQL on production and hand the counts to ADR-003
  - Switch the five consumers of the v1 default (`definition-step.ts` `buildDefault`, the clone and seed fallbacks in `workflow-definitions.post.ts`, `builtin-prompt-drift.ts`, `carry-schema-drift.ts`) to `defaultWorkflowDefinitionV2`, then delete the v1 default
  - Delete `executeGraph` and its private helpers; collapse every `schemaVersion === 1` branch and every constant `=== 2` guard to the v2 arm across `workflows/agent.ts`, `definition-step.ts`, `prompt-references-step.ts`, the listed block files, `lib/dispatch*.ts`, and the workflow-definition store/runtime files
  - Rename `toLegacyRuntimeShape` to `toRuntimeShape` (shape kept, not deleted)
  - Delete `isV2OnlyBlockType`, the three singular shim routes, `v2-converter.ts`, `v2-migration*.ts`, `[id]/migrate.post.ts`, and the dashboard migration drawer
  - Narrow the runnable `WorkflowDefinition` to v2; make the version-history read return `{ kind: "v2", definition } | { kind: "legacy-v1", raw }`
  - Rollback to a v1 version returns 409 naming the retired schema; editor hides Restore on v1 rows; clipboard rejects a v1 payload
  - Update the `save_draft` tool description sentence and regenerate `mcp-contract.json`
  - Add the permanent gate `scripts/gates/single-schema-version.mjs`, registered in `verify:changed` and `ci.yml`
  - Append the shim and migrate route paths to the resurrected-paths list
  - Drop v1 cases from the 18 worker and 8 dashboard test files that pin them
- File scope: `apps/worker/src/workflow-definition/{interpreter,schema,validation,store,default,templates,v2-converter,v2-migration,v2-migration-prompts,v2-migration-harness-profiles,harness-profile-runtime,layout,graph-fixtures}.ts`, `apps/worker/src/workflows/{agent,definition-step,prompt-references-step}.ts` (version branches only), `apps/worker/src/workflows/blocks/{fix-agent,prepare-workspace,types,test-support}.ts` (version branches only), `apps/worker/src/lib/{dispatch,dispatch-trigger}.ts` (three lookups only), `apps/worker/src/prompt-library/builtin-prompt-drift.ts`, the v1 route files under `apps/worker/src/routes/api/v1/` (workflow-definitions.post, workflow-definition.get/put, workflow-definition/restore.post, workflow-definitions/[id]/migrate.post), `apps/worker/src/mcp/tool-catalog.ts` and `mcp-contract.json`, `packages/contracts/src/{domain,workflow-graph}.ts`, `apps/dashboard/lib/{flows.ts,workflow-editor/**}`, dashboard editor and flow-editor components, `scripts/gates/single-schema-version.mjs`, `scripts/gates/no-resurrected-paths.json`, `verify-changed.ts` and `ci.yml` (one gate entry each), the 26 test files that pin v1; after stage 3
- Acceptance criteria:
  - [ ] `node scripts/gates/single-schema-version.mjs` exits 0 (pattern: `schemaVersion (===|!==) [12]\b|schemaVersion: 1( \| 2)?\b|isV2OnlyBlockType|executeGraph\b` over `apps` and `packages`, excluding tests, the harness-profile manifest files and the single history parser), and a fixture reintroducing `schemaVersion === 1` fails it
  - [ ] `pnpm typecheck` passes
  - [ ] `pnpm --filter worker exec vitest run src/workflow-definition src/workflows src/routes src/lib src/prompt-library` passes
  - [ ] `pnpm --filter ai-workflow-dashboard test` passes
  - [ ] `pnpm --filter worker mcp:contract:check` passes and the recorded hash differs from the start-SHA hash
  - [ ] `pnpm --filter worker run db:generate` produces no migration
  - [ ] The reviewer attaches a table of every collapsed version site (6 `=== 1` and 13 `=== 2` in `agent.ts` at the start SHA, 2 in the store, 3 in dispatch, the rest per file) showing the v2 arm kept verbatim
  - [ ] Preview deploy plus both non-dry canaries pass
  - [ ] A `workflows.get_graph` sweep on production after deploy returns all 9 definitions
  - [ ] ADR-003 carries the SQL counts
- Notes: Executes D12 and A11 (owner reversed Q4 the same day: v1 is retired inside this plan, not as a separate plan).

### Stage 4: Block manifest and generator
- Jira type: Task
- Jira key: AIW-344
- Parent: the epic above
- Labels: architecture, restructure, stage-4
- Depends on / Related: after stage 3b (shares `blocks/*` and `contracts/domain.ts` with it); inside the first freeze; AIW-293 block-contract tasks (AIW-294, 297, 305, 306, 300, 301) land only after this stage
- Freeze: first (workflows) - inside
- Suggested executor: opus, skeptic yes (block contracts are business logic), TDD yes (generator fixture: block dir -> three expected outputs; a manifest importing a runtime module fails generation; existing registry/schema/catalog tests are the regression net), delegation yes (moving 26 block files into directories)
- Summary: each block type gets one directory with `manifest.ts` and `execute.ts`; a generator writes the block-catalog, params-schema-map and executor-map files from those manifests only, so definition validation never imports an executor.
- Scope:
  - Move each block into `engine/blocks/<type>/{manifest,execute}.ts` (move, not rewrite)
  - Add `scripts/gates/generate-block-catalog.ts` writing `packages/contracts/src/block-catalog.generated.ts`, `engine/definition/params.generated.ts`, `engine/blocks/executors.generated.ts`
  - `schema.ts` and `block-registry.ts` consume `params.generated.ts`
  - Turn `block-catalog-sync.test.ts` into `gen:blocks --check`
  - Delete `docs/workflow-workspace/index.html` (replaced by the generated catalog, per A7)
  - Dashboard palette reads `BLOCK_TYPE_SPECS` from the generated file; block forms untouched
  - Write `docs/architecture/blocks.md`
- File scope: `apps/worker/src/workflows/blocks/**`, `apps/worker/src/engine/blocks/**` (new), `apps/worker/src/workflow-definition/{block-registry,schema}.ts` (import sections), the `BLOCK_EXECUTORS` section of `workflows/agent.ts` only, `packages/contracts/src/{domain,workflow-graph,block-catalog.generated}.ts`, `scripts/gates/generate-block-catalog.ts`, root `package.json` (`gen:blocks` script), `docs/workflow-workspace/**`, `docs/architecture/blocks.md`; after stage 3b
- Acceptance criteria:
  - [ ] `pnpm --filter worker exec vitest run src/workflow-definition src/engine/blocks` passes
  - [ ] `gen:blocks --check` fails after editing a manifest and passes after `pnpm run gen:blocks`
  - [ ] `pnpm --filter ai-workflow-dashboard build` and `pnpm --filter ai-workflow-dashboard test` pass from a fresh checkout with no manual generation step
  - [ ] The attached tier-pair table shows zero `engine/definition -> engine/blocks/*/execute` edges and the `definition <-> blocks` cycle row at 0
  - [ ] `docs/architecture/blocks.md` walks through adding a block in one directory, and a reviewer follows it on a throwaway block that is then deleted
- Notes: Executes D4 (blocks as self-describing modules with a pure manifest).

### Stage 5: Split `agent.ts` into `engine/agent-workflow` and `engine/steps`
- Jira type: Task
- Jira key: AIW-345
- Parent: the epic above
- Labels: architecture, restructure, stage-5
- Depends on / Related: after stage 4; inside the first freeze
- Freeze: first (workflows) - inside, closes when this stage lands on `main`
- Suggested executor: opus, skeptic yes (the run state machine lives here), TDD no (pure move; the existing `workflows/` tests plus the two discovery tests are the net), delegation no
- Summary: `agent.ts` splits into `engine/agent-workflow.ts` (the `"use workflow"` function, body unchanged), `engine/steps/*.ts`, and pure helpers; the six dispatchers import only from `engine/index.ts`.
- Scope:
  - Split `agent.ts` into `engine/agent-workflow.ts`, `engine/steps/*.ts`, pure helpers
  - `engine/index.ts` exports `agentWorkflow`; the six dispatchers import from it
  - Move `"use step"` files in the mixed service directories (per the D3 table) to `engine/steps/` in the same PR
  - The six dispatcher import sites are `lib/dispatch.ts:27`, `lib/dispatch-trigger.ts:15`, `approvals/dispatch.ts:7`, `schedule-trigger/dispatch-schedule-trigger.ts:9`, `webhook-trigger/dispatch-webhook-trigger.ts:6`, `manual-dispatch/service.ts:16`
  - Append `apps/worker/src/workflows` to the resurrected-paths list
- File scope: `apps/worker/src/workflows/**`, `apps/worker/src/engine/**`, `"use step"` files under `approvals/`, `clarifications/`, `manual-dispatch/`, `webhook-trigger/`, `schedule-trigger/`, `pre-sandbox/`, `pre-pr-checks/`, `sandbox/`, `workflow-definition/` (move only), the six dispatcher import lines, `scripts/gates/no-resurrected-paths.json`; after stage 4; inside the first freeze
- Acceptance criteria:
  - [ ] `workflow-import-boundary.test.ts` and `step-registration-coverage.test.ts` pass
  - [ ] `pnpm --filter worker exec vitest run src/engine` passes
  - [ ] The reviewer confirms with `git diff --color-moved=dimmed-zebra` that the workflow body moved with zero logic edits, recording the before and after SHA of the function in the PR
  - [ ] Preview deploy plus both non-dry canaries pass (as in stage 3)
  - [ ] `rg -l '"use step"' apps/worker/src --glob '!src/engine/**'` is empty
  - [ ] The tier-pair table shows `lib <-> workflows` and `sandbox <-> workflows` rows at 0
- Notes: Executes D5 (the workflow body as its own module). Landing this stage on `main` closes the first freeze (D10, A8).

### Stage 5b: Behavioural PR gate on the engine (D11)
- Jira type: Task
- Jira key: AIW-346
- Parent: the epic above
- Labels: architecture, restructure, stage-5b
- Depends on / Related: after stage 5 (sequential per the plan's Parallelism paragraph); requires AIW-316 merged; delivers the live-canary half of AIW-199 and the production-dispatch mode of AIW-196
- Freeze: none
- Suggested executor: sonnet, skeptic no, TDD no, delegation no
- Summary: a CI job that, for any PR touching `apps/worker/src/engine/**`, `apps/worker/src/db/**` or `packages/**`, deploys a preview and runs both non-dry canaries, joining the `ci` aggregator's needs.
- Scope:
  - Add a CI job scoped to `apps/worker/src/engine/**`, `apps/worker/src/db/**`, `packages/**`
  - The job deploys a preview and dispatches a run that executes at least one `"use step"` and one WDK webhook function, asserting the replay
  - The job joins the `ci` aggregator's needs
  - Until this stage exists, stages 3 and 5 ran the same two canaries manually as their own DoD; this job makes that automatic and required
  - Static gates observe structure, not behaviour: this is the plan's only PR check that runs a real workflow against a real deployment
  - Scope stays narrowed to the engine, the DB layer and the packages, per A12, so a docs or dashboard PR never pays for a preview deploy plus an LLM-backed run
- File scope: `.github/workflows/ci.yml` (new job), `e2e/replay/preview-canary.ts`, `e2e/harness-profiles/preview-canary.ts` (CI-mode flags only), `docs/architecture/gates.md`
- Acceptance criteria:
  - [ ] A PR that edits one step body triggers the job and it passes
  - [ ] A PR that only edits `docs/` does not trigger it, and `ci` still reports
  - [ ] A PR that deliberately renames a step function without re-registering it fails the job with the "not registered" message visible in the log
- Notes: Executes D11 and A12 (owner: yes, pay one preview deploy plus one LLM-backed run per PR on this narrowed scope). Requires AIW-316 merged so a canary can never dispatch against production.

### Stage 6a: `config/` and `infra/` tiers
- Jira type: Task
- Jira key: AIW-347
- Parent: the epic above
- Labels: architecture, restructure, stage-6a
- Depends on / Related: after stage 5b; opens the second freeze
- Freeze: second (lib, routes) - opens at the start of this stage
- Suggested executor: sonnet, skeptic no, TDD no, delegation yes (import sweep)
- Summary: `config/env.ts` becomes the single importer of the worker's `env.ts`; infra modules named in the D3 table move to `infra/`; every other file gets its `env` import replaced by a parameter or a `config` accessor.
- Scope:
  - Move `env` access behind `config/env.ts` as the single importer of `apps/worker/env.ts`
  - Move the infra modules named in the D3 table (logger, telemetry, llm-provider, llm, github-webhook-sig, webhook-crypto, unique-violation, vcs-urls) to `infra/`
  - Replace every other `env` import with a parameter or a `config` accessor
  - Per D3, allowed edges here are `config -> nothing` and `infra -> nothing`: neither tier may import anything else in the worker
  - This stage opens the second freeze; per A8 the window is expected to last two to four working days if 6a, 6b and 6c run back to back
- File scope: `apps/worker/src/config/**`, `apps/worker/src/infra/**`, the infra files listed in D3, every file whose only change is an `env` import line; after stage 5b; inside the second freeze
- Acceptance criteria:
  - [ ] `rg -l 'from ".*env\.js"' apps/worker/src --glob '!src/config/**'` is empty
  - [ ] `pnpm typecheck` passes
  - [ ] `pnpm --filter worker exec vitest run src/lib src/config src/infra` passes
  - [ ] The tier-pair table is attached and smaller
- Notes: Executes D3 (worker tiers, allowed edges) and opens the second freeze (D10, A8: `apps/worker/src/lib` and `apps/worker/src/routes` frozen until stage 6c lands).

### Stage 6b: `services/` clusters
- Jira type: Task
- Jira key: AIW-348
- Parent: the epic above
- Labels: architecture, restructure, stage-6b
- Depends on / Related: after stage 6a; inside the second freeze
- Freeze: second (lib, routes) - inside
- Suggested executor: sonnet, skeptic no, TDD no, delegation yes (cluster moves from the audit's inventory)
- Summary: the `lib/` clusters and the mixed service directories of D3 move into `services/<cluster>/` with an `index.ts` per cluster as its interface; store and schema files stay in place for stage 7.
- Scope:
  - Move the `lib/` clusters (dispatch, run-lifecycle, tickets, publication, overview, auth, slack) into `services/<cluster>/` with an `index.ts` interface each
  - Move the mixed service directories (approvals, clarifications, manual-dispatch, dispatch-queue, webhook-trigger, schedule-trigger, system-health, repository-discovery), non-store and non-step files only
  - Leave store and schema files in place for stage 7
  - Append `apps/worker/src/lib` and each moved directory to the resurrected-paths list
- File scope: `apps/worker/src/lib/**` (not moved in 6a), `apps/worker/src/services/**`, the eight mixed service directories (non-store, non-step files), `apps/worker/src/deployment-identity.ts`, `scripts/gates/no-resurrected-paths.json`; after stage 6a; inside the second freeze
- Acceptance criteria:
  - [ ] `apps/worker/src/lib` no longer exists, and `no-resurrected-paths` lists it
  - [ ] `pnpm typecheck` passes
  - [ ] `pnpm --filter worker exec vitest run src/services` passes
  - [ ] The tier-pair table is attached and smaller
  - [ ] `docs/architecture/overview.md` lists the clusters with one-sentence contracts
- Notes: Executes D3 (services tier); the mixed-directory split rule (store/schema to db in stage 7, `"use step"` files to engine in stage 5, the rest here) comes from the D3 table.

### Stage 6c: Server surface becomes thin
- Jira type: Task
- Jira key: AIW-349
- Parent: the epic above
- Labels: architecture, restructure, stage-6c
- Depends on / Related: after stage 6b; closes the second freeze; AIW-293 trigger-scope tasks (AIW-295, AIW-298) land only after this stage
- Freeze: second (lib, routes) - closes when this stage lands on `main`
- Suggested executor: opus (permissions and webhook verification live here), skeptic yes (webhook auth, rate limit, revocation), TDD yes for the extracted services (existing route tests become service tests), delegation no
- Summary: the three audited handlers and the MCP tools move their branching into services; no route or MCP tool imports `db/client` or `env`; every POST validates with a `@shared/contracts` schema.
- Scope:
  - Move branching out of the three audited handlers (`webhooks/jira.post.ts`, `cron/poll.get.ts`, `webhooks/custom/[endpointId].post.ts`) and the MCP tools, into services
  - No route or MCP tool imports `db/client` or `env`
  - Every POST validates with a `@shared/contracts` schema (fixes `invites.post.ts` and `webhooks/resend.post.ts`)
  - `routes/` keeps its path and name (Nitro scans it)
  - New service files under `apps/worker/src/services/{triggers,polling,custom-webhooks,mcp}/`
- File scope: `apps/worker/src/routes/**`, `apps/worker/src/mcp/**`, `apps/worker/src/middleware/**`, `apps/worker/src/plugins/**`, `apps/worker/src/auth*.ts`, new files under `apps/worker/src/services/{triggers,polling,custom-webhooks,mcp}/`; after stage 6b; inside the second freeze
- Acceptance criteria:
  - [ ] `rg -l 'getDb\(|from ".*db/client' apps/worker/src/routes apps/worker/src/mcp` is empty
  - [ ] `rg -l 'readBody<' apps/worker/src/routes` is empty
  - [ ] `pnpm --filter worker exec vitest run src/routes src/mcp src/services` passes
  - [ ] `workflow-import-boundary.test.ts` passes
  - [ ] `pnpm --filter worker build:ci` passes
  - [ ] The 5b behavioural job passes on the PR
- Notes: Executes D3 (app tier, thin server surface). Landing this stage on `main` closes the second freeze (D10, A8).

### Stage 7: DB repositories and fences (D7)
- Jira type: Task
- Jira key: AIW-350
- Parent: the epic above
- Labels: architecture, restructure, stage-7
- Depends on / Related: after stage 6c; waits for AIW-335 (production driver becomes `node-postgres`) to merge; AIW-293 memory tasks (AIW-303) land only after this stage
- Freeze: none
- Suggested executor: sonnet, with opus for the auth repository; skeptic yes (auth writes move behind a repository); TDD yes (gates first; the AIW-335 production-driver BEGIN/ROLLBACK contract test runs against the repository layer; repository functions covered by moving the existing `db/queries` tests); delegation yes (call-site sweep)
- Summary: repositories per domain own the operations on their tables, starting with the three hottest (`workflowRuns`, `workflowDefinitions`, `activeRuns`); transactions become legal only inside `db/repositories/*`; the `db/client` fence count ratchets down from 357.
- Scope:
  - Add `db/repositories/{runs,definitions,active-runs,auth}.ts`; move the auth writes behind the repository, keeping their transactions there
  - Add `scripts/gates/transactions-in-repositories.mjs` (fails on `.transaction(` outside `db/repositories`)
  - Split `db/schema/<domain>.ts`, re-exported from `db/schema.ts`
  - Move `store.ts` and `*-schema.ts` files from the mixed directories under `db/`
  - Add `scripts/gates/db-client-fence.mjs` (baseline 357, ratchet down)
  - Write `docs/architecture/data-model.md` with the 62-table ownership table
- File scope: `apps/worker/src/db/**`, `apps/worker/src/services/auth/**` (call sites), `store.ts`/`*-schema.ts` files of the mixed directories, `scripts/gates/{transactions-in-repositories,db-client-fence}.mjs`, `docs/architecture/data-model.md`; call-site migration touches `services/**` and `engine/**`; after stage 6c and after AIW-335
- Acceptance criteria:
  - [ ] `pnpm --filter worker run db:generate` produces no new migration
  - [ ] All `*-migration.test.ts` pass
  - [ ] `transactions-in-repositories` gate exits 0
  - [ ] The AIW-335 BEGIN/ROLLBACK contract test passes through `db/repositories/auth.ts`
  - [ ] The `db-client-fence` baseline drops below 300 in this stage
  - [ ] The 5b behavioural job passes
- Notes: Executes D7 (repositories per domain, transactions only inside them). If AIW-335 is cancelled, per A13, this stage reverts to the pre-revision rule: no transactions anywhere, four auth sites rewritten as single statements.

### Stage 8a: `packages/prompts`
- Jira type: Task
- Jira key: AIW-351
- Parent: the epic above
- Labels: architecture, restructure, stage-8a
- Depends on / Related: after stage 7; disjoint from stages 8b, 8c, 8d
- Freeze: none
- Suggested executor: opus, skeptic yes (what a prompt resolves to is product behaviour), TDD yes (the 14 dashboard test files and the worker prompt tests move first and must stay green), delegation no
- Summary: slot, reference, variable, composition and builtin-default logic move into one package; the dashboard's separate `lib/prompt-library` copy is deleted; the drift gate moves with it.
- Scope:
  - Move prompt logic from `packages/contracts/prompt-*.ts`, `workflow-definition/prompt-*.ts`, `lib/prompts.ts`, `engine/steps/prompt*.ts` (pure parts) and `apps/dashboard/lib/prompt-library/*` into `packages/prompts`
  - Delete the dashboard copy; its 14 test files move with the code
  - Move the builtin drift gate with it
- File scope: `packages/prompts/**`, `packages/contracts/src/prompt-*.ts`, `apps/worker/src/engine/prompt-library/**`, `apps/worker/src/engine/definition/prompt-*.ts`, `apps/worker/src/engine/steps/prompt*.ts`, `apps/dashboard/lib/prompt-library/**`, `apps/dashboard/components/cockpit/prompt-editor/**` (imports only); after stage 7
- Acceptance criteria:
  - [ ] `apps/dashboard/lib/prompt-library` no longer exists, and it is on the resurrected-paths list
  - [ ] `pnpm --filter @shared/prompts test` passes
  - [ ] The builtin drift gate passes
  - [ ] A fixture prompt resolves byte-identically through worker and dashboard entry points (parity test)
  - [ ] The 5b behavioural job passes
- Notes: Executes D6 (one owner per concept, one drift test each) for prompt composition.

### Stage 8b: `packages/harness`, model catalog (D6, A6)
- Jira type: Task
- Jira key: AIW-352
- Parent: the epic above
- Labels: architecture, restructure, stage-8b
- Depends on / Related: after stage 7; disjoint from stages 8a, 8c, 8d
- Freeze: none
- Suggested executor: sonnet, skeptic yes (which models a user may pick; the gate receives ADR-006's table and asks about every model the union would newly expose), TDD yes (drift test first; a test asserts `selectable()` equals the pre-change picker list per provider), delegation no
- Summary: `model-catalog.ts` owns model ids with `recognised` (union, for parsing) and `selectable(providerContract)` (intersection, for pickers); the dashboard, the manifest, and the capability catalog derive from it.
- Scope:
  - Add `packages/harness/src/model-catalog.ts` with `recognised` and `selectable()` per D6
  - First commit is the four-column comparison table of today's four model lists, committed as `docs/adr/ADR-006-model-catalog.md`
  - `manifest.ts`, `capability-catalog.ts`, `workflow-definition/models.ts` and `apps/dashboard/lib/harness-profiles/*` derive from the owner
  - Add a drift test that greps the repo for model-id literals outside the owner
  - This is a NEW seam: today four separate lists exist and none of them is disjoint from the others
  - The four lists are not four copies of one fact, so unifying them naively could widen what a user may select (A6); any newly exposed model is a deliberate one-line change to `selectable()`, made after this stage
- File scope: `packages/harness/**`, `packages/contracts/src/harness-profiles.ts`, `apps/worker/src/engine/harness-profiles/**` (non-skill files), `apps/worker/src/engine/definition/models.ts`, `apps/dashboard/lib/harness-profiles/**`, `docs/adr/ADR-006-model-catalog.md`; after stage 7; disjoint from stages 8a, 8c, 8d
- Acceptance criteria:
  - [ ] `rg -n 'claude-(opus|sonnet|haiku|fable)-|gpt-5' apps packages --glob '!**/model-catalog.ts' --glob '!*.test.ts' --glob '!docs/**'` is empty
  - [ ] `pnpm run test:e2e:harness-profiles:dry` passes
  - [ ] The dashboard picker snapshot test is unchanged
- Notes: Executes D6 and A6 (owner: intersection for pickers, union for parsers; no model becomes newly selectable without a deliberate one-line change to `selectable()`).

### Stage 8c: `packages/costs`
- Jira type: Task
- Jira key: AIW-353
- Parent: the epic above
- Labels: architecture, restructure, stage-8c
- Depends on / Related: after stage 7; disjoint from stages 8a, 8b, 8d
- Freeze: none
- Suggested executor: sonnet, skeptic no, TDD yes (parity test first), delegation no
- Summary: one `costForUsage(provider, usage)` function owns price table shape and usage aggregation, used by Slack formatting, run budget and the dashboard cost screen, with a parity test for the Claude and Codex paths.
- Scope:
  - Add `packages/costs/**` with `costForUsage(provider, usage)`
  - Move price table shape and usage aggregation logic from `sandbox/usage.ts`, `sandbox/agents/pricing.ts`, `run-budget.ts`
  - Add a parity test for Claude `cost_usd` and Codex token pricing
  - Satisfies D2 (a package needs two consumers): the worker's sandbox, run-budget and Slack formatting, and the dashboard's cost screen
  - The observed behaviour this seam guarantees per the Seams table: one number for one usage record, regardless of provider
- File scope: `packages/costs/**`, `apps/worker/src/engine/sandbox/{usage,agents/pricing}.ts`, `apps/worker/src/engine/run-budget.ts`, `apps/dashboard/app/cost-data.tsx`, `apps/dashboard/app/(cockpit)/cost/**`; after stage 7; disjoint from stages 8a, 8b, 8d
- Acceptance criteria:
  - [ ] `pnpm --filter @shared/costs test` passes
  - [ ] A recorded usage fixture yields the same cost in worker and dashboard
  - [ ] Slack message snapshot tests are unchanged
- Notes: Executes D6 (one owner per concept) for the cost function.

### Stage 8d: `packages/skills`
- Jira type: Task
- Jira key: AIW-354
- Parent: the epic above
- Labels: architecture, restructure, stage-8d
- Depends on / Related: after stage 7; disjoint from stages 8a, 8b, 8c
- Freeze: none
- Suggested executor: opus (two discovery paths become one interface), skeptic no, TDD yes (conformance test run against both adapters; a malformed manifest fails identically from both), delegation no
- Summary: manifest schema, lock-file format, validator and one `SkillSource` interface move into one package; the GitHub and local adapters satisfy it; the drift gate covers both sources.
- Scope:
  - Move manifest schema, lock-file format, validator from `harness-profiles/{github-skills,configured-github-skills,local-skills,skill-artifact}.ts` and `scripts/validate-local-skills.ts` into `packages/skills`
  - Define one `SkillSource` interface; the GitHub and local adapters satisfy it
  - The drift gate covers both sources
  - Write `docs/architecture/skills.md` stating the product-skill vs Claude-Code-skill distinction and why `skills/` sits at the repository root
  - Satisfies D2 (a package needs two consumers): the worker's harness-profiles runtime and the dashboard's skill picker and validator both read through `SkillSource`
- File scope: `packages/skills/**`, `apps/worker/src/engine/harness-profiles/*skill*.ts`, `apps/worker/scripts/validate-local-skills.ts`, `apps/worker/skills-lock.json`, `docs/architecture/skills.md`; after stage 7; disjoint from stages 8a, 8b, 8c
- Acceptance criteria:
  - [ ] `pnpm --filter worker validate:local-skills` passes
  - [ ] The conformance test passes for both adapters
  - [ ] A GitHub-sourced skill with a hash mismatch fails the drift gate (fixture)
- Notes: Executes D6 (one owner per concept) for the skill source; folds in pre-mortem finding #8 (skills should not stay folded into harness).

### Stage 9: Dashboard hygiene: one API client, block form split
- Jira type: Task
- Jira key: AIW-355
- Parent: the epic above
- Labels: architecture, restructure, stage-9
- Depends on / Related: after stages 8a, 8b, 8c, 8d
- Freeze: none
- Suggested executor: sonnet, skeptic no, TDD no (119 existing tests, the two 2000-line render tests are the net), delegation yes (case-by-case split)
- Summary: one API client in `lib/api/client.ts` with typed endpoints from contracts replaces 29 direct `fetch(` sites; `config-fields.tsx` splits mechanically into one file per block type.
- Scope:
  - Add `lib/api/client.ts` with typed endpoints from `@shared/contracts`
  - Route the 29 direct `fetch(` sites through the client
  - Split `config-fields.tsx` into `flow-editor/blocks/<type>.tsx`, one file per `case` (mechanical)
  - The existing 119 dashboard tests, including the two 2000-line render tests, are the regression net; no new tests are scoped for this stage
- File scope: `apps/dashboard/lib/api/**`, `apps/dashboard/components/**`, `apps/dashboard/app/api/**`, `apps/dashboard/AGENTS.md`; after stages 8a, 8b, 8c, 8d
- Acceptance criteria:
  - [ ] `rg -l 'fetch\(' apps/dashboard/components apps/dashboard/app --glob '!lib/api/**' --glob '!*.test.*'` is empty
  - [ ] `pnpm --filter ai-workflow-dashboard test` passes
  - [ ] No file under `components/` exceeds 1000 lines
- Notes: The docs-routing seam (D9) gains this rule in dashboard `AGENTS.md`.

### Stage 10: Agent configuration alignment
- Jira type: Task
- Jira key: AIW-356
- Parent: the epic above
- Labels: architecture, restructure, stage-10
- Depends on / Related: after stage 9
- Freeze: none
- Suggested executor: sonnet, skeptic yes (agent behaviour), TDD no, delegation no
- Summary: `verify:changed` runs as a `Stop` hook, the gate ladder and release procedures become skills linking to docs, and a proof exists that per-app and path-scoped instructions actually load.
- Scope:
  - Wire `verify:changed` as a `Stop` hook in `.claude/settings.json`
  - Turn the gate ladder and release procedures into skills that link to docs
  - Trim `AGENTS.md` files to their final form
  - Prove per-app and path-scoped instructions load, via a `/context` transcript
  - Per D9, procedures (the gate ladder, the release process) become skills, not docs; docs stay reference material
- File scope: `.claude/settings.json`, `.claude/rules/**`, `.claude/skills/**`, `AGENTS.md`, `apps/*/AGENTS.md`; after stage 9
- Acceptance criteria:
  - [ ] A `/context` transcript from a session started at the repo root, editing one file under `apps/worker/src/services/auth`, shows `apps/worker/AGENTS.md` and one `.claude/rules/*.md` loaded
  - [ ] Root `AGENTS.md` is under 200 lines
  - [ ] The hook fires on a test push in a throwaway branch
- Notes: Executes D9 (docs routing seam) for the agent-facing half.

### Stage 11: Ratchet to zero: delete every baseline
- Jira type: Task
- Jira key: AIW-357
- Parent: the epic above
- Labels: architecture, restructure, stage-11
- Depends on / Related: after stage 10
- Freeze: none
- Suggested executor: sonnet, skeptic no, TDD no, delegation yes (sweep)
- Summary: remaining boundary violations, knip findings and the `db/client` fence count are driven to zero; every baseline file is deleted and the rules become hard, since ADR-001 gives every directory a tier.
- Scope:
  - Drive remaining boundary violations, knip findings and `db/client` fence count to zero
  - Delete all `*.baseline.json` files
- File scope: any file a baseline names; `scripts/gates/*.baseline.json`; after stage 10
- Acceptance criteria:
  - [ ] All `*.baseline.json` files are deleted
  - [ ] `pnpm run verify:changed` and CI are green with hard rules (no baseline exceptions)
  - [ ] `docs/architecture/gates.md` lists the ladder with no baseline column
- Notes: Terminates because every directory already has a tier (ADR-001); this stage has no open-ended scope left to ratchet.

## Creation checklist

1. Create the epic first ("Architecture restructure 2026-09: tiers, packages, gates, docs"), labelled `architecture`, `restructure`.
2. Create the 19 tickets in stage order (0, 1, 2, 3, 3b, 4, 5, 5b, 6a, 6b, 6c, 7, 8a, 8b, 8c, 8d, 9, 10, 11), setting Parent to the epic on each.
3. Paste each ticket's Summary, Scope and Notes into the description, and its Acceptance criteria as the checkbox list (or the project's Acceptance Criteria field, if it has one).
4. Add the Labels listed per ticket, including the `stage-N` label.
5. Link each "Depends on / Related" key with the matching Jira issue-link type (`blocks` / `is blocked by`, `relates to`).
6. Write every created key back into this file's "Jira key" fields.
7. Write every created key into the plan's stage table (`2026-09-09-architecture-restructure.md`) as a new "Jira" column.
