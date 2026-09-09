# Roadmap and Jira backlog against the restructure plan

Date: 2026-09-09. Inputs: the 27 Aug 2026 roadmap (checked in as
[../product/roadmap-2026-08-27.md](../product/roadmap-2026-08-27.md), 106
unchecked items across P0-P3 and four milestones), the full open AIW backlog
(100 issues, `project = AIW AND statusCategory != Done`, fetched 2026-09-09:
45 To do, 33 Backlog, 9 in verification as tasks, plus 10 subtasks and 3
epics), the descriptions of AIW-199, AIW-260, AIW-313, AIW-325, AIW-326,
AIW-335, the merge state of PRs #358-#360, and the plan
[../plans/2026-09-09-architecture-restructure.md](../plans/2026-09-09-architecture-restructure.md).

Question answered: does the plan give a clean base for the roadmap, the bug
fixes and the backlog, and where does it collide with work already in flight?

Short answer: the plan and the stabilisation track already in Jira want the
same things and were about to build three of them twice. Four plan elements
change (stage 0, stage 1, stage 5b, D7 with stage 7); the rest of the plan
turns out to be the missing precondition for most of the roadmap's P1-P3.

---

## 1. Where the stabilisation track stands

AIW-326 records the executable P0 order as of `main@172de9c6` (2026-09-04):
AIW-313/#358 -> AIW-314/#360 -> G2 enforcement -> AIW-322/#359; then
AIW-315/321/323; then AIW-316 -> AIW-317 -> AIW-320 -> AIW-318 (exact-SHA
go/no-go for the isolated demo environment).

State on 2026-09-09:

| Item | State | Evidence |
|---|---|---|
| AIW-313 credential-free production bundle in CI | PR #358 merged 2026-09-06; ticket in verification | `build:ci` in `apps/worker/package.json` runs validators plus `nitro build` without `db:migrate` or `seed:auth-user`; `ci.yml` has `source-checks`, `unit-worker`, `unit-dashboard`, `workflow-sdk`, aggregator `ci` |
| AIW-314 poll-agent test isolation | Done, PR #360 merged | |
| AIW-322 capacity fixtures fail closed | Done, PR #359 merged | |
| AIW-315 scope-aware pre-push gate | Done | `.githooks/pre-push`, `scripts/ci/verify-changed.ts` |
| AIW-323 Dependabot reconciliation | Done | |
| **G2 enforcement** (required check on `main`) | **not done** | GitHub API: no protection, no rulesets |
| AIW-321 pin Actions, minimise token persistence | To do, High | |
| AIW-316 / 317 / 318 isolated demo identity, fixtures, go/no-go | To do, High, p0 | `deployment-identity.ts`, `verify-deployment-identity.ts` exist |
| AIW-320 harden secret-bearing e2e | To do, High | |
| AIW-326 reconcile roadmap and Jira graph | To do, High | says `docs/AI-WORKFLOW-ROADMAP.md` is a 2026-08-13 historical snapshot |
| AIW-327 / 328 / 329-335 Better Auth 1.7 rollout | in verification; AIW-335 (transaction-capable driver) To do | |

The next gate in that order is exactly the plan's stage 0.

---

## 2. Collisions between the plan and the backlog

| Ticket | Plan element | What was about to happen twice | Resolution applied to the plan |
|---|---|---|---|
| AIW-313 (verification) | Stage 0 "required `ci` on `main`" | Both define the aggregate check and the branch-protection flip. AIW-313 also separated bundling from migration, which the audit listed as a risk. | Stage 0 is the open remainder of AIW-313: make `ci` reportable, require it, close the ticket with the evidence it asks for. No new ticket. The audit's "migrations run during build" risk is reduced to `vercel build` only. |
| AIW-335 (To do) | D7 and stage 7 "throw on `.transaction(`, gate everything" | AIW-335 ports production `getDb()` to `drizzle-orm/node-postgres` with `pg` 8.20.0 because Better Auth 1.7 needs adapter transactions, with a real BEGIN/ROLLBACK contract test. The plan was about to forbid the thing AIW-335 makes work. | D7 reversed: transactions become legal, but only inside `db/repositories/*`; the gate fails `.transaction(` anywhere else; stage 7 runs after AIW-335 merges and reuses its contract test. The memory note "neon-http has no transactions" stays true until AIW-335 lands. |
| AIW-325 (To do) | Stage 1 boundary gate; stage 5 WDK discovery test | AIW-325 wants the workflow import-boundary check to distinguish executable Node imports from import-like text in string literals and to fail closed on a real forbidden import. Stage 1 would have added a second boundary tool beside it. | AIW-325 becomes part of stage 1's scope: dependency-cruiser owns directory tiers, the WDK bundle check owns "no Node import in workflow VM code", and both get a negative fixture. |
| AIW-199, AIW-196 (Backlog) | Stage 5b behavioural PR gate | AIW-199 defines deterministic template-scenario CI plus environment-gated live canaries; AIW-196 adds a production-dispatch mode to the scenario harness. Stage 5b is the live-canary half, written without knowing the ticket. | Stage 5b delivers the live-canary half of AIW-199 and AIW-196's dispatch mode against the preview. The deterministic half (AIW-195, 197, 198) is pulled forward as a prerequisite of stage 4, see section 5. |
| AIW-260 / 316 / 317 / 318 (To do, High) | Stage 5b preview deployment; stage 3 and 5 canary DoD | The preview the canaries run against must be the isolated identity AIW-316 proves, or a canary can dispatch against production tickets. | Stage 5b and the canary DoDs depend on AIW-316 (identity fence) being merged; `verify-deployment-identity.ts` is the preflight. AIW-317 fixtures are what the canaries should seed. |
| AIW-326 (To do, High) | Stage 2 docs taxonomy | AIW-326 wants one dated executable baseline linked from the canonical roadmap, the 2026-08-13 file kept as history, superseded statements recorded. Stage 2 wants `docs/product/roadmap` and an archive. | The roadmap is now checked in at `docs/product/roadmap-2026-08-27.md` with a status header; stage 2 archives `docs/AI-WORKFLOW-ROADMAP.md` under AIW-326's rules and AIW-326 owns the Jira link cleanup. |
| AIW-182 (Backlog, High) "capability-driven model and compaction controls" | D6 model catalog, stage 8b | AIW-182 needs one place that says which models a provider supports and what they can do. Today that is four files. | Stage 8b is the precondition; AIW-182 is the first feature that lands on the new catalog. |
| AIW-294 "injection check: typed output enum, halt main workflow" and AIW-297 "unify input/param naming for MCP" (AIW-293 epic) | D4 block manifest, stage 4 | Both edit block contracts in `block-registry.ts`, `schema.ts` and `config-fields.tsx`, the files stage 4 restructures. | Land after stage 4 (one directory per block) or they are done twice. Section 6. |

---

## 3. Roadmap themes and where they land

Each theme of the 27 Aug roadmap, the tier or package it lands in after the
plan, the stage that makes it cheap, and what stays hard until then.

| Roadmap theme | Landing zone | Enabling stage | Hard until then because |
|---|---|---|---|
| **P0 Prompt composition and governance** (inventory of instruction sources, precedence rules, exact effective instructions per run, versioning, diffs, rollback) | `packages/prompts` plus `engine/steps/prompt*` | 8a | composition logic exists twice (worker and dashboard); "show the exact effective instructions" cannot be true while the dashboard computes its own version (AIW-300 is the same item) |
| **P0 Tenant release verification** (deployed versions per tenant, drift detection, definition migration on schema change, rollback) | `services/system` (deployment identity, exists), `packages/workflow-graph` for definition migration | 2 (ADR-003), 3b, 12 | migrating deployed definitions when schemas change needs one schema (3b) and a pure graph package; the version surface itself is already there |
| **P0 PR and MR feedback handling** (pending feedback blocks the no-op exit, comment identity and status, coalescing, no parallel fixes on one PR) | `services/dispatch` (coalescing, ownership), `engine/steps` (review ledger, exists) | 6b | the coalescing and ownership logic sits in `lib/dispatch*.ts` and the three big route handlers; it can be fixed today but every fix is another branch in a 700-line handler |
| **P0 Webhooks and integration health** (admin health page, delivery history, idempotent duplicates) | `services/system-health` (exists), `app/routes/webhooks` thin, dashboard health screen | 6c | webhook handlers verify, decrypt, rate-limit and dispatch inline; delivery history storage belongs to a repository the plan creates in 7 |
| **P0 Failed-check remediation** (fix agent on same PR, stale heads, explicit no-commit failure, retry caps) | `engine/pre-pr-checks`, `engine/steps` | 5 | `agent.ts` owns terminal disposition and the autofix loop in one 3600-line body; AIW-292 (duration budget kills runs) and AIW-311 (finalize failure mislabelled) are symptoms |
| **P0 Pre-PR checks and repository environments** (setup commands, "failed" vs "could not start", redacted output tail, budgets) | `engine/pre-pr-checks`, repository scripts (exist) | 5 | same file |
| **P0 Runtime resilience** (diagnostic IDs, typed causes, capacity exhaustion reported, no re-claim of terminated work, resume after clarification) | `services/run-lifecycle`, `engine/steps/clarification*` | 6b, 5 | AIW-277, 279, 280, 289 are all here; they are fixable now and should be fixed before the freezes (section 5) |
| **P1 Explicit domain model** (tickets, repos, branches, PRs, threads, comments, checks, runs as linked entities) | `db/repositories` per domain, `packages/contracts` | 7 | 62 tables written from 15 directories with no owner; the data-model document with table ownership is the first artefact of this theme |
| **P1 Ticket and PR workflow decomposition** (separate PR/MR workflows, context-resolution block, workspace preparation limited to provisioning) | `engine/agent-workflow.ts` plus a second `"use workflow"` entrypoint, `engine/blocks/context-resolution` | 4, 5 | a second workflow entrypoint is a copy of 3600 lines today; after stage 5 it is a new file that composes existing steps |
| **P1 Trigger-owned configuration** (Jira mapping per trigger, repo scope per trigger, independently enabled triggers) | `services/triggers`, `packages/contracts` | 6c | trigger config is split between `env.ts` (global) and definition triggers; AIW-295 is the same item |
| **P1 Repository profiles** (descriptions, relationships, setup groups, versioned) | `db/repositories/repositories`, repository scripts (exist) | 7 | |
| **P2 Typed workflow composition** (typed inputs, outputs, decisions, failure routes per block; halt on flagged safety check) | `engine/blocks/*/manifest.ts`, `packages/workflow-graph` | 4, 12 | the manifest is where a typed output contract lives; AIW-294, 296, 297, 305, 306 are this theme |
| **P2 Context and run transparency** (only bound context reaches the agent, per-block inputs, outputs, model, tools, skills) | `engine` (prompt runtime, sandbox context), `run-observability` | 5, 8a | AIW-300, 301, 302 |
| **P2 Permissions and onboarding** | `app` (Better Auth wiring), `services/auth` | 6b, AIW-328 | |
| **P2 Documentation and reusable workflows** (block docs, cloneable workflows, regression fixtures, rollback loads into editor) | `docs/architecture/blocks.md` (generated from manifests), scenario harness (AIW-194) | 2, 4 | AIW-307, AIW-288 |
| **P2 Operational dashboard** (attribution by cost, model, tenant; separate evidence from charts; feature-flag unfinished areas) | `packages/costs`, dashboard | 8c, 9 | AIW-290, 304 |
| **P3 Chat-agent integration** (MCP actions to list, dispatch, monitor, answer, retrieve) | `app/mcp` thin over `services` | 6c | the MCP tools already exist (28-tool contract) and already duplicate route logic (fan-out to 14 directories); without a service layer every new MCP action is a second implementation |
| **P3 Third-party integrations** (Extensions tab, Arthur card, reusable extension contract) | a new `adapters/extensions` seam plus `packages/contracts` extension types | after 6b | not in the plan; the adapter tier is where it goes, and it should not start before the tiers exist |
| **P3 Provider-neutral safety and observability** (typed pass / block / human-review outcomes with evidence) | `packages/contracts`, `engine/blocks` (injection check) | 4 | AIW-294 is the first block to get a typed outcome |
| **P3 Hosted and on-premise execution** (infrastructure and sandbox adapters instead of forks) | `adapters/sandbox` (new seam; one adapter today, Vercel Sandbox) | after 6b | a seam with one adapter is hypothetical; do not build it until an on-prem tenant is real (AIW-43) |

Reading of the table: the plan is the precondition for two thirds of the
roadmap. The P0 rows are mostly fixable today at a higher cost per fix; the
P1-P3 rows are not reasonably buildable on the current structure without
adding to the tangle.

---

## 4. Milestones against stages

| Roadmap milestone | Plan stages that must land first |
|---|---|
| M1 Stable pilot (P0 scenarios pass in a tenant, feedback cannot false-exit, integrations visible, failures diagnosable) | 0 (required CI), 5b with AIW-316 (real run on an isolated preview); the P0 bug fixes themselves do not wait for the restructure |
| M2 Correct multi-repository workflows (explicit relationships, separate PR follow-up workflow, trigger-specific config) | 4, 5, 6c, 7 |
| M3 Self-service builder and operations (typed, documented blocks; tenant regressions before release) | 4, 8a-8d, 9, AIW-194 epic |
| M4 External orchestration and extensions | 6c, then the extension seam |

---

## 5. Open bugs and the freeze windows

High-priority open bugs (all labelled `client-arthur-ai`): AIW-277 dispatch
refuses silently when the pool is full; AIW-279 a parked run never notices
its ticket was deleted; AIW-280 an answered clarification whose resume never
completed parks the run forever; AIW-292 the default duration budget kills
runs mid-checks; AIW-284 (verification) expansion gates on a human when the
model requests only attached repos; AIW-187 copied agent blocks retain
overrides. Medium: AIW-268, 269, 275, 283, 287, 289, 311, 337.

Every one of them touches `lib/dispatch*`, `clarifications/`, or
`workflows/agent.ts`, which is exactly the freeze zone of stages 4-5 and 6a-6c.

Rule adopted in the plan: **bugs first, freezes second.** Stages 0-3 touch
none of those files, so bug fixes flow in parallel with them. The first freeze
does not start until the High bugs above are merged or explicitly deferred by
the owner. During a freeze, a High bug in the frozen directory is fixed on
top of the restructure branch by the same executor, not on `main`.

Recommended prerequisite: AIW-195 and AIW-197 (strict scenario harness for
the standard templates, both Backlog) before stage 4. They turn the 79
workflow tests plus two discovery tests into a behavioural net for the two
riskiest moves. Without them stages 4 and 5 rely on unit tests and one
preview run.

---

## 6. The AIW-293 epic (workflow builder fixes) and stage 4

Fourteen tasks from the 2026-08-17 review. Split by whether they edit block
contracts:

* **After stage 4** (they change what a block declares): AIW-294 typed
  injection output and halt, AIW-297 param naming unification, AIW-305
  structured JSON input on generic agent, AIW-306 skills visible on agent
  blocks (also after 8d), AIW-300 effective prompt shows bound data (also
  after 8a), AIW-301 no unbound runtime data in the sandbox (engine, after 5).
* **Any time** (UI or isolated): AIW-296 bindings UX, AIW-299 PR block copy
  and fix-cycle display, AIW-304 cost graph clipping, AIW-288 rollback loads
  into the editor, AIW-290 feature-flag dashboard tabs.
* **After 6c**: AIW-295 repo scope at the trigger, AIW-298 ticket context for
  PR-triggered workflows.
* **After 7**: AIW-303 memory filtering and cleanup process.
* **Docs**: AIW-307 composition docs, produced by stage 4's generator plus
  stage 2's taxonomy.

---

## 7. Changes applied to the plan (revision 3)

1. Stage 0 is the open remainder of AIW-313, not a new gate.
2. Stage 1 absorbs AIW-325 (string-literal false positives, fail-closed
   negative fixture) and states which tool owns which boundary.
3. D7 and stage 7 reversed: transactions legal only inside `db/repositories`
   once AIW-335's `node-postgres` driver lands; stage 7 ordered after AIW-335
   and reuses its BEGIN/ROLLBACK contract test.
4. Stage 5b delivers the live-canary half of AIW-199 plus AIW-196, depends on
   AIW-316 for the isolated identity.
5. New assumptions A13 (AIW-335 driver) and A14 (AIW-195/197 before stage 4),
   the latter also a question to the owner.
6. Sequencing rule "bugs first, freezes second" and the AIW-293 split written
   into the plan.
7. The roadmap is checked into `docs/product/` so AIW-326 has a canonical
   file to link and no decision record points at a Downloads path.

One risk surfaced for AIW-335 itself, recorded here because the ticket does
not mention it: the memory note from 2026-07-13 says `neon-http` was chosen
deliberately because `getDb()` must also load inside Workflow DevKit step
bundles (the run path and the `send_plan_approval` block run there), where a
socket-based pool could not run at the time. AIW-335's acceptance criteria
prove BEGIN/ROLLBACK through the production factory and Neon-over-TCP pool
behaviour, but not that a `pg` pool initialises and executes inside a step
bundle on Vercel. That proof belongs in AIW-335 before stage 7 depends on it.

---

## 7b. Changes applied in revision 4 (v1 retirement, 2026-09-09)

The owner reversed Q4 after reading the plan: v1 is retired inside this plan
instead of in a separate one. Reason given: no customer runs v1 (the Arthur
tenant is out of support) and two live schemas create chaos. Evidence
gathered before the change:

* Production (`workflows.list` then `workflows.get_graph`, 2026-09-09): 9
  non-archived definitions (ids 2, 11, 12, 14, 23, 25, 28, 29, 32), every
  deployed graph and every draft at `schemaVersion: 2`. Archived definitions
  and `workflow_definition_versions` rows are not visible through MCP and are
  measured by SQL at the start of stage 3b.
* Nothing creates v1 any more: `workflow-definitions.post.ts:177` and
  `templates.ts:1505` emit v2; the singular shim routes
  (`workflow-definition.get.ts`, `.put.ts`, `workflow-definition/restore.post.ts`)
  still serve the v1 default and are called only by their own tests
  (`workflow-definitions.test.ts:2280,2319`).
* The eight scenario snapshots under `workflow-definition/scenarios/snapshots/`
  are all v2, so AIW-195/197 (A14) is the behavioural net for the deletion.
* Blast radius in code: the v1 walker (`interpreter.ts:414`), about 30
  `schemaVersion` branches in `agent.ts`, three in dispatch, two in the store,
  the converter and migration modules (about 2300 lines), the dashboard's
  v1 defaults in `lib/workflow-editor/*` and `lib/flows.ts`, 18 worker and 8
  dashboard test files. Harness-profile manifests have their own
  `schemaVersion` and are excluded.

Plan changes: D12 added, A11 rewritten, stage 3b inserted between 3 and 4
(opens the first freeze), stage 2 writes ADR-003 as Accepted, stage 12 loses
its condition, D10 and A8 start the first freeze at 3b.
Stage 3b then had its own skeptic pass (REVISE, 10 findings); all ten are
triaged in the plan's second pre-mortem table, the largest being that the v1
default is still the fresh-install run path (`definition-step.ts:132`) and is
now replaced by the v2 default rather than deleted.

Backlog effect: AIW-293 tasks that touch the editor's serialisation (AIW-294,
297) should land after 3b as well as after 4, since 3b removes the
`schemaVersion = 1` defaults they would otherwise build on. No open ticket
asks for v1 support.

## 8. What the backlog lacks

* **Tickets for the restructure stages themselves.** Nothing in AIW tracks
  the tier map, the block manifest, the `agent.ts` split, the packages, or
  the docs taxonomy. Recommendation: one ticket per stage, parented to a new
  epic, created when the owner approves the plan, with the plan's DoD copied
  as acceptance criteria. AIW-326's rule applies: statuses move on merged
  evidence, not prose.
* **A ticket for the extension seam** (roadmap P3, third-party integrations)
  so it is not improvised inside the Arthur work.
* **AIW-239** (MCP endpoint) is still "To do" although the MCP trilogy merged
  on 2026-08-26 and the 28-tool contract is in the repo; AIW-326's status
  reconciliation should close or re-scope it.
* **Vendored `.agents/skills`, `.kimi-code`, `design-qa.md`** have no ticket;
  stage 2 deletes them and needs none.
