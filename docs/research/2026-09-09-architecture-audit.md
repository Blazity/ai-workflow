# Architecture audit: current state and target shape

Date: 2026-09-09. Scope: the whole monorepo (`apps/worker`, `apps/dashboard`,
`apps/shared/*`, `docs/`, agent configuration). Method: one deterministic
import-graph script plus eight read-only reconnaissance agents, each on one
topic, every claim cited as `file:line`. Companion documents:

* [2026-09-09-agent-navigable-codebase.md](./2026-09-09-agent-navigable-codebase.md):
  what Anthropic publishes about agent-navigable repositories (primary sources).
* [2026-09-09-monorepo-boundary-enforcement.md](./2026-09-09-monorepo-boundary-enforcement.md):
  primary sources on package contracts, import-boundary enforcement, and the
  constraints Vercel Workflow and Nitro impose.
* [2026-09-09-roadmap-backlog-fit.md](./2026-09-09-roadmap-backlog-fit.md):
  the 27 Aug roadmap and the 100 open AIW issues mapped onto the plan.
* [../plans/2026-09-09-architecture-restructure.md](../plans/2026-09-09-architecture-restructure.md):
  the staged plan that follows from this audit.

Vocabulary follows the codebase-design skill: **module** (interface plus
implementation), **interface** (everything a caller must know), **seam** (where
an interface lives), **adapter** (a thing that satisfies an interface at a
seam), **depth** (behaviour per unit of interface), **leverage** (what callers
get from depth), **locality** (what maintainers get from depth).

---

## 1. Verdict in one paragraph

The code is layered in the small and tangled in the large. Real seams exist
(VCS adapters, agent runtimes, messaging, block executors), but the directory
tree above them is a flat set of 28 folders with 28 two-way import cycles, no
service layer, a 140-file `lib/` that holds most of the domain logic, and an
8209-line file that is simultaneously the workflow body, the step library and
the block executor table. Adding one block type touches 24 files in 8
directories. Four cross-cutting concepts (prompts, skills, harness profiles,
costs) each have two to four competing definitions. Documentation is 153 files,
roughly 110 of them dated journals, with no navigable path from the entry
points to any rationale. Nothing enforces any of this at merge time: `main`
has no branch protection, the worker has no linter, and no tool checks import
boundaries. **A rewrite is not warranted and would be the wrong move; a
behaviour-neutral restructure with enforcement first is.** The engine, the
adapters and the block executors are worth keeping as they are. What has to
change is where things live, what may import what, and which single file owns
each concept.

---

## 2. Measurements

Source: `tokei`, `git log --since='90 days ago'`, and the import-graph script
([2026-09-09-import-graph.mjs](./2026-09-09-import-graph.mjs), directory-level,
non-test edges only; rerun with `node docs/research/2026-09-09-import-graph.mjs "$PWD"`).

| Metric | Value |
|---|---|
| Files (apps/*, excluding node_modules, dist, .next) | 1518 |
| TypeScript lines (code) | 278 576 in 1184 files |
| TSX lines (code) | 47 614 in 173 files |
| Worker `src/` top-level directories | 28 |
| Two-way import cycles between those directories | 28 |
| Directories `routes/` imports from | 24 |
| Directories `workflows/` imports from | 21 |
| Directories that import `lib/` | 21 |
| Directories that import `db/` | 22 |
| Directories that import `env.ts` directly | 16 |
| Files carrying `"use step"` (WDK step scope) | 46 (39 in `workflows/`) |
| Files carrying `"use workflow"` | 2 |
| Largest file | `apps/worker/src/workflows/agent.ts`, 8209 lines |
| Largest dashboard file | `components/cockpit/flow-editor/config-fields.tsx`, 5090 lines |
| Test files: worker / dashboard / scripts | 414 / 77 / 14 |
| Churn (files touched, 90 days): `workflows/` | 1277 |
| Churn: `workflow-definition/` / `lib/` / `routes/` | 688 / 659 / 600 |

Heaviest edges: `routes->lib` 215, `workflows->lib` 183, `workflows->sandbox`
149, `routes->db` 106, `workflows->db` 86, `routes->@shared/contracts` 82.

Heaviest cycles (A->B / B->A import counts): `workflow-definition<->workflows`
28/38, `sandbox<->workflows` 7/149, `lib<->workflows` 8/183, `lib<->adapters`
10/40, `db<->lib` 3/49, `lib<->sandbox` 5/19.

The churn numbers matter for the plan: `workflows/` is the hottest directory
in the repo and also the one every cycle passes through. Any restructure of it
competes with feature work for the same files.

---

## 3. Findings: worker runtime

### 3.1 Block definition is smeared across eight places

A block type today is declared in:

1. the type union `WorkflowBlockType` in `apps/shared/contracts/domain.ts:290`;
2. `BLOCK_TYPE_SPECS` in `apps/shared/contracts/workflow-graph.ts:42`;
3. the registry builder `buildWorkflowBlockRegistry` in
   `apps/worker/src/workflow-definition/block-registry.ts:1944` (1972-line file);
4. the params schema map in `apps/worker/src/workflow-definition/schema.ts:35-50`,
   which imports `paramsSchema` from every executor file (this import is the
   heaviest cycle in the repo, `schema.ts:41` reaching into
   `workflows/blocks/investigate.js`);
5. the executor map `BLOCK_EXECUTORS` at `apps/worker/src/workflows/agent.ts:530`
   plus an inline `switch` for `INLINE_EXECUTED_BLOCK_TYPES` (`agent.ts:~555`)
   and the guard `blockTypesMissingExecutor()` (`agent.ts:567`);
6. the executor itself, one file per block under `apps/worker/src/workflows/blocks/`
   (14 of them already export their own `paramsSchema`);
7. the dashboard form, a hand-written `switch` over block type in
   `apps/dashboard/components/cockpit/flow-editor/config-fields.tsx:4404-4830`;
8. a hand-maintained HTML catalog `docs/workflow-workspace/index.html` (123 KB)
   that `block-catalog-sync.test.ts` parses with `node:vm` and asserts against
   the registry.

Evidence of cost: commit `9b52286f` (leak_review block) touched 24 files in 8
directories; commit `38fe3415` (investigate block) touched 47 files including
a migration and a scenario snapshot.

Judgment: each block file already exports `paramsSchema` and `execute`. The
repo is one export short of a self-describing block module. Generating the
registry entries, the executor map and the catalog from a directory scan
removes items 3, 4, 5 and 8 from the touch list and deletes the heaviest cycle.

### 3.2 `agent.ts` is three modules in one file

Outline (line ranges): 1-289 imports and constants; 289-460 v2 prompt and
provenance helpers; 461-566 `executeRunScripts` and `BLOCK_EXECUTORS`;
567-1515 pure helpers; 1515-2350 step functions (ticket comments, run
analysis); 2350-2960 terminal disposition and review ledger; 2965-3230
clarification parking; 3232-3700 pre-PR and repository-script failure
reporting; 3700-4590 budgets and telemetry steps; 4591-8209 the single
`"use workflow"` function `agentWorkflow`, roughly 3600 lines in one body.

This is the only chokepoint every run passes through. It is also why
`lib/dispatch.ts:27` must import `agentWorkflow`, closing the `lib<->workflows`
cycle.

The one guard that makes a split safe already exists:
`workflows/workflow-import-boundary.test.ts:55-70` runs the real WDK builder
and asserts every file containing `"use step"` or `"use workflow"` appears in
its discovered lists, because discovery is content-based and an unrecognised
file fails silently at runtime ("not registered in the current deployment").
`step-registration-coverage.test.ts` covers the other direction.

### 3.3 v1 definitions are live, not legacy

`workflow-definition/definition-step.ts:89` branches on `schemaVersion === 1`
and passes v1 through; v2 definitions are flattened *down* to the v1 runtime
shape (`:91-108`). The built-in default definition is still emitted as
`schemaVersion: 1` (`workflow-definition/default.ts:90`), a v2 default exists
beside it (`default.ts:149`), `store.ts:1243,1407` branches per version, and
blocks are partitioned into v1-executable and v2-only (`isV2OnlyBlockType`,
`agent.ts:248,571`). No decision record says why both are kept;
`docs/workflow-definitions.md` describes v1 only (see 7.2).

### 3.4 Seams that are real today

| Seam | Interface | Adapters | Test double |
|---|---|---|---|
| VCS | `adapters/vcs/types.ts` (`VCSAdapter`, capability mixins at `:64-70`) | `github.ts:397`, `gitlab.ts:161` | none shared; hand-rolled object literals per test (`post-pr-gate/runner.test.ts`, `review-thread-conformance.test.ts:20`) |
| Agent runtime | `sandbox/agents/types.ts` (`AgentAdapter`), factory `agents/index.ts:11` | `claude.ts`, `codex.ts` | protocol fixtures (`agents/fixtures`, `protocol-fixtures.test.ts`) |
| Messaging | `adapters/messaging/types.ts:62` | `chatsdk.ts`, `noop.ts:8` | `NoopMessagingAdapter` is a production fake |
| Issue tracker | `adapters/issue-tracker/types.ts:72` | `jira.ts` only | hypothetical seam (one adapter) |
| Run registry | `adapters/run-registry/types.ts:61` | `postgres.ts` only | hypothetical seam |

The sandbox is deep in the good sense: 53 files, five externally used exports
(`createAgentAdapter`/`AgentKind`, `WORKSPACE_ROOT_DIR`/`WorkspaceManifest`,
`ResolvedHarnessRuntime`, `computeUsageTotals`, `formatPRComments`). Its one
accidental leak is `sandbox/context.ts:16` importing
`workflows/review-ledger.js` while `workflows/prompt-vars.ts:8` imports
`sandbox/context.js`: two halves of one review-ledger formatter split across
directories.

### 3.5 No service layer; `lib/` is the domain

`lib/` (140 files) clusters into: trigger dispatch and coalescing
(`dispatch.ts`, `dispatch-trigger.ts`, `post-pr-gate-dispatch.ts`,
`pr-autofix-*.ts`, `active-run-owner.ts`), run lifecycle (`cancel-run.ts`,
`reconcile.ts`, `human-decisions-memory.ts`), VCS and webhook runtime
(`github-auth.ts`, `github-webhook-sig.ts`, `gitlab-webhook.ts`,
`create-vcs.ts`, `adapters.ts`), ticket and AI-review transitions
(`ai-review-*.ts`, `move-targets.ts`, `labels.ts`), publication scrubbing,
prompts and LLM wrappers, `auth/` (invites, roles, SSO handoff), `email/`,
`overview/` (eleven `collect-*` read models for the dashboard), `slack/`,
`telemetry/`, and about six pure infrastructure modules (logger, llm-provider,
signature verification, request context, trusted origins). Roughly 60 of the
70 modules are domain logic.

Routes are not thin. `routes/webhooks/jira.post.ts` (736 lines) calls
`decideAiReviewRun`, `classifyProtectedClarificationSubjects` and
`listApprovalParkedSubjects` against `getDb()` inline (`:279, :308-311, :356,
:382`) and computes an HMAC digest in the handler (`:584`).
`routes/cron/poll.get.ts` (612 lines) loops over approvals, dispatches and
triggers and branches on result variants (`:107-138, :406-469`);
`routes/webhooks/custom/[endpointId].post.ts` (442 lines) does lookup,
revocation, rate limit, decrypt, verify and dispatch branching (`:155-277`).
29 route files obtain the raw `Db` handle via `getDb()` and thread it into
`lib` helpers. No route builds a Drizzle query inline, which is the one
layering rule the code already satisfies.

`db/queries/` holds four modules (run reads, PR siblings, workflow-owned
branches) and is not a repository layer; everything else queries through ad
hoc `lib` functions taking a `Db` parameter.

`apps/worker/env.ts` (561 lines, `createEnv` from `@t3-oss/env-core`) is
imported directly from more than a dozen directories, including domain code
(`routes/cron/poll.get.ts:3` reads `env.CRON_SECRET` at `:489`).

Input validation at the boundary is inconsistent: `api/v1` CRUD POSTs validate
with `@shared/contracts` (`workflow-definitions.post.ts:12`,
`harness-profiles.post.ts:4`, `prompt-library.post.ts:5`); `invites.post.ts:12`
uses an untyped `readBody<{...}>`; `webhooks/resend.post.ts:50` is a bare
`JSON.parse(rawBody) as ResendEmailDeliveryEvent`.

### 3.6 Database: 62 tables, no owner per table

Schema files: `db/schema.ts` (46 tables, 1747 lines), `db/auth-schema.ts` (14),
and one table each in `approvals-schema.ts:27`, `clarifications-schema.ts`,
`email-delivery-schema.ts`, `memory-schema.ts`. 58 migrations
(`drizzle/0000_elite_paibok.sql` to `0057_run_analysis_report.sql`, journal in
`drizzle/meta/_journal.json`, no duplicate numbers). Production applies them
during `build` (`apps/worker/package.json:7` -> `scripts/db-migrate.ts:38`,
guarded by the `env_marker` check at `:47-69`). The `*-migration.test.ts`
files replay the real SQL on PGlite, so they test migrations, not TS logic.

Access pattern: 357 files outside `db/` import the client directly
(`routes/api/v1` 34, `lib` 31, `workflows` 28, `workflows/blocks` 23, `mcp`
17). `db/queries/` has 4 files and 37 exported functions, used from
`workflows/blocks` (9), `lib` (8) and `workflows` (5). The three most shared
tables are written from many directories: `workflowRuns` (`schema.ts:454`)
from 15, `workflowDefinitions` (`schema.ts:914`) from 13, `activeRuns` from 10.

Transactions: six `.transaction(` call sites, four in production
(`lib/auth/invite-acceptance.ts:126,191`, `lib/auth/invites.ts:76,205`). The
memory note that `neon-http` has no transactions and returns 500 in production
while PGlite passes is tribal knowledge only: `db/client.ts` has no guard, no
lint, no wrapper. AIW-335 (open) ports the production driver to
`drizzle-orm/node-postgres` with a BEGIN/ROLLBACK contract test because Better
Auth 1.7 needs adapter transactions; the plan's rule is written for that
driver.

Judgment: the one rule that would give each table an owner without a migration
is "only `db/` imports the client; everything else goes through a repository
module per domain that exports the allowed operations", ratcheted down from
today's 357 call sites. A runtime throw or lint on `db.transaction()` under
`neon-http` is a separate, cheap fix.

### 3.7 Nitro and WDK facts that constrain any move

`apps/worker/nitro.config.ts`: preset `vercel`, `srcDir: "src"`, tests ignored
by the file router, `workflow/nitro` module, and a `compiled` hook that copies
optional YAML files and the repository-root `skills/` directory into every
`.func` bundle (WDK emits separate step, flow and webhook functions, each with
its own `/var/task`). `externals: { inline: ["zod/v3"] }` exists because the
Vercel tracer otherwise installs only Zod 4 while the MCP catalog imports
`zod/v3`.

The worker `tsconfig.json` includes `../shared/contracts/**/*.ts` as source
while runtime resolution goes through the built `dist/` declared in
`apps/shared/contracts/package.json` `exports`. Every `test`, `typecheck` and
`dev` script therefore starts with `pnpm build:shared`. Two resolution paths
for one package is a latent drift point and a tax on every command.

From the boundary-enforcement research (primary sources): `workflow/nitro`
roots step and workflow discovery at Nitro's `workspaceDir`, the pnpm root,
so sibling workspace packages may be imported by workflow code, but discovery
is directory-list based (`dirs`, default `workflows/` plus all layer source
directories) and the semantics of custom entries are undocumented. `"use
workflow"` bodies run sandboxed and must be deterministic; `"use step"` bodies
have full Node access, which is where DB clients and side effects belong. The
pinned `nitropack@2.13.4` ships `srcDir` as a live option; the current
`nitro.build` docs describe Nitro 3, where `srcDir` is deprecated for
`serverDir`, so any Nitro upgrade changes the scan root and must re-run the
discovery test. Node's `exports` map is the real access gate at runtime
(unlisted subpaths throw `ERR_PACKAGE_PATH_NOT_EXPORTED`). pnpm's default
strict linking blocks phantom dependencies only; a relative import across
packages is not stopped by anything today.

---

## 4. Findings: four cross-cutting concepts

| Concept | Where it is defined today | Source of truth | Duplication | Drift gate |
|---|---|---|---|---|
| **Prompts** | `apps/shared/contracts/{default-prompts,default-agent-prompt-references,prompt-references,prompt-slots,prompt-variables}.ts`; `apps/worker/src/prompt-library/{store,builtin-prompts,builtin-prompt-drift,builtin-prompt-drift-gate}.ts`; `workflow-definition/{prompt-authoring,prompt-preview,v2-migration-prompts}.ts`; `lib/prompts.ts`; `workflows/{prompts-step,prompt-references,prompt-references-step,prompt-vars,effective-prompt}.ts`; `apps/dashboard/lib/prompt-library/*` (about 15 files); `components/cockpit/prompt-editor/*`; migration `0022_prompt_slots.sql` plus five `*_builtin_prompt_resync.sql` | `default-prompts.ts` for shape and defaults, `prompt-library/store.ts` for state | the dashboard re-implements slot resolution and composition instead of reusing the worker's; five resync migrations record repeated drift | present (`builtin-prompt-drift-gate.ts`, and a vitest test) |
| **Skills** (product-side, shipped into the sandbox) | `harness-profiles/{github-skills,configured-github-skills,local-skills,skill-artifact}.ts`; `apps/worker/scripts/validate-local-skills.ts`; `apps/worker/skills-lock.json`; repository-root `skills/ai-workflow-review/SKILL.md` (copied into every function bundle by `nitro.config.ts`); `docs/example-skill/SKILL.md` | none: manifest schema in `skill-artifact.ts`, versions in `skills-lock.json`, two discovery paths (GitHub source vs local source) | the product skill tree and the Claude Code skill tree (`.claude/skills`) share the `SKILL.md` convention and are easy to confuse; the Anthropic research confirms `skills/` at the root is not a Claude Code location, which is correct for a product artifact but undocumented | local skills only; none for GitHub-sourced |
| **Harness profiles** | `apps/shared/contracts/harness-profiles.ts`; `harness-profiles/manifest.ts` (`HARNESS_PROVIDER_CONTRACTS`, model list 1); `harness-profiles/capability-catalog.ts` (model list 2); `workflow-definition/models.ts` (`FALLBACK_MODELS`, list 3); `apps/dashboard/lib/harness-profiles/{capabilities,editor,selection}.ts` (list 4); `harness-profiles/store.ts` (CRUD, fork, publish, archive); `workflow-definition/harness-profile-runtime.ts` | none; model identifiers are hard-coded in three to four files with no shared enum | yes, four lists | absent |
| **Costs / usage** | `sandbox/agents/pricing.ts` (price table, live fetch from LiteLLM); `sandbox/usage.ts` (aggregation, Slack formatting); `workflows/run-budget.ts` (budget limits); `run-observability/*`; `apps/dashboard/app/cost-data.tsx` and `app/(cockpit)/cost/page.tsx` (`CostResponse` from contracts) | split cleanly into price (`pricing.ts`) and usage (`usage.ts`, `run-budget.ts`) | two cost paths: Claude reports `cost_usd` directly, Codex is tokens times price in `usage.ts`; dashboard aggregation is not reconciled with the Slack figure | absent |

Extractability ranking: prompts (module exists, contracts shared, gate exists;
the work is a move plus deleting the dashboard copy), then costs (clean split,
needs one shared cost function), then skills (manifest and lock exist, two
discovery paths need one interface), then harness profiles (must unify the
model catalog before anything can move).

---

## 5. Findings: dashboard

* Twelve cockpit pages under `app/(cockpit)/`, each a server component pair
  `app/<screen>-data.tsx` plus `<screen>-skeleton.tsx` behind `Suspense`. Data
  chain: `app/(cockpit)/page.tsx:8-17` -> `app/overview-data.tsx:44-52`
  (`getJSON<KpisResponse>`) -> `lib/api/server.ts:31-41` (`fetch` to
  `WORKER_BASE_URL`, bearer session cookie) -> `apps/worker/src/routes/api/v1/overview/*`.
* `lib/api/` is one typed helper (`getJSON`, `withQuery`), not a client with
  per-endpoint types. 29 files outside `lib/api` call `fetch(` directly
  (`components/cockpit/screens/health.tsx:116`,
  `manual-dispatch-modal.tsx:70,95`, most of `flow-editor/*.tsx`), some through
  the dashboard's own `app/api/*` proxies.
* 176 files import `@shared/contracts`; `lib/types.ts` adds UI-only views
  (`Span`, `EvalMetric`, `CostByModel`) rather than duplicating domain types.
  The dashboard is a thin client at the type level.
* It is not thin at the logic level: `config-fields.tsx` (5090 lines) is a
  hand-written form per block type (`:4404-4830`), with large custom editors
  for webhook triggers (`:878-2107`), schedules (`:2107-3530`) and repository
  scripts (`:3658-4268`). A comment at `:4396` says the palette is data-driven;
  the forms are not. `lib/prompt-library/*` and `lib/harness-profiles/*`
  re-implement worker logic (section 4).
* Design layer exists: `components/ui.tsx` (23 importers), `charts.tsx`;
  `lib/theme.ts` is only span colours.
* 119 test files; the two largest render with `react-test-renderer`
  (`screens/repository-scripts.test.tsx` 2445 lines,
  `config-fields-schedule-trigger.test.tsx` 1853 lines).
* Both dashboard-local docs are stale: `docs/overview-api-requirements.md:1-4`
  describes a migration that already happened;
  `docs/superpowers/plans/2026-05-28-overview-real-data.md:9-24` specifies
  `lib/integrations/*` and SWR hooks that were never built.

---

## 6. Findings: verification gates

What runs where today:

| Gate | Where | Enforced? |
|---|---|---|
| `git diff --check` | `verify:changed` (pre-push) only | local, bypassable |
| typecheck (worker / dashboard / root) | pre-push, scoped to changed paths; CI `source-checks` | CI not required |
| unit tests (worker sharded, dashboard, workflow-sdk) | CI on every PR, 30-minute timeouts, 5-minute aggregator `ci` | CI not required |
| `validate:pre-sandbox`, `validate:local-skills`, `mcp:contract:check` | pre-push (worker paths) and `build:ci` | via build |
| `check:prompt-drift`, `check:carry-schema-drift` | plain vitest tests, caught by `unit-worker` | via CI |
| `verify-deployment-identity` | `e2e.yml` only (nightly) | no |
| e2e (agent / orchestration / capacity projects) | nightly cron or manual, needs a deployment | no |
| linter (worker) | none exists | no |
| `next lint` (dashboard) | defined, never run in CI | no |
| import boundaries, unused code (dependency-cruiser, knip or similar) | none | no |
| coverage threshold | none | no |

`core.hooksPath` is set to `.githooks` in this checkout, so pre-push runs, but
`--no-verify` is one flag away and `AGENTS.md` itself calls the gate advisory.
`main` has no branch protection, by recorded decision, so a red `ci` job blocks
nothing. The memory note "ci on a 35-minute ceiling" does not match the current
`ci.yml` (30/30/30/30/5).

Judgment: the cheapest large improvement is a repository setting, not code:
require the existing `ci` aggregator on `main`. After that, the missing gates
are lint, boundaries and unused-code detection, none of which exist in any form.

---

## 7. Findings: documentation and decisions

### 7.1 Inventory summary

153 documents. Sources of truth that are current and mutually consistent:
`AGENTS.md` and `docs/delivery-gates.md` (process), `docs/SPEC.md` and
`docs/user-stories.md` (behaviour), `docs/AI-WORKFLOW-ROADMAP.md` (status; it
beats the README wherever they disagree), `CONTEXT.md` (vocabulary),
`docs/releases/artur/` (release contract), `docs/repository-scripts.md`,
`docs/GITHUB-APP-SETUP.md`, `docs/GITLAB-SETUP.md`, `SETUP.md` (environment,
contested by the setup skills).

Journals (dated, describing a past state): `docs/plans/` (32),
`docs/superpowers/` (55, split across three trees: `docs/`, `apps/worker/docs/`,
`apps/dashboard/docs/`), `docs/qa/` (11 plus an 85 KB HTML playbook),
`docs/testing/` (8), `docs/research/` (4), `docs/assumptions/` (2),
`.claude/learnings.md` (56 KB, cold since 2026-06-29, loaded by nothing).

Dead or orphaned: `design-qa.md` (root, referenced nowhere),
`docs/agent-runtime-diagnostics.md` (referenced nowhere),
`docs/workflow-workspace/index.html` (a generated design mock used as a test
fixture), `.agents/skills/` (20 vendored third-party skills, untouched since
2026-05-28, referenced nowhere), `.kimi-code/skills/` (a diverged copy of
`.claude/skills`, 14 files differ, one skill missing, git-ignored through
`.git/info/exclude`, so nothing keeps it in sync).

### 7.2 Contradictions found

1. **Post-PR gate.** `docs/plans/2026-08-04-legacy-post-pr-gate-neutralization.md:3`
   says "Status: APPLIED", `apps/worker/post-pr-gate.yaml` carries the sentinel
   and `steps: []`, yet `docs/post-pr-gate-spec.md` (73 KB, last commit
   2026-05-22) has no status header across 2270 lines, and
   `.claude/skills/init-neon/SKILL.md:4` still describes Neon as the "post-PR
   gate store".
2. **GitLab project id.** `SETUP.md:134`: numeric project IDs are not
   supported. `.claude/skills/init-vcs/SKILL.md:61`: numeric ID works.
   `GITLAB_HOST` exists only in the skill (`:63,76`). `SETUP.md:713` points at
   the skills; `init-neon/SKILL.md:12` points back at `SETUP.md`. Resolved
   against the code: `lib/vcs-urls.ts:4` builds the sandbox clone URL as
   `${host}/${repoPath}.git`, so a numeric id cannot work and `SETUP.md` is
   right on that point; `GITLAB_HOST` is a real variable (`env.ts:49`, default
   `https://gitlab.com`), so `SETUP.md` is missing it. Both documents need one
   edit each.
3. **Workflow definitions doc describes v1 only.** `docs/workflow-definitions.md:3`
   declares `schemaVersion: 1`; its "V1"/"V2" headings (`:32`, `:54`) are two
   fixtures both at version 1; the v2 layer (`v2-converter.ts`, `v2-bindings.ts`,
   `v2-branch.ts`, `v2-migration.ts`, `v2-scheduler.ts`) is never mentioned.
   `README.md:89` sends readers to this file for the block catalog.
4. **README vs roadmap.** `README.md:57` lists PR/MR lifecycle triggers as
   present; `docs/AI-WORKFLOW-ROADMAP.md:66` (AIW-221) has them "implemented,
   awaiting verification". `README.md:64` lists customer-controlled deployment;
   the roadmap (`:83-87`, AIW-260) has it "planned, not started".
5. **A decision record sourced from a laptop path.**
   `docs/plans/2026-07-23-ai-workflow-improvements-decisions.md:5` cites
   `/Users/karol/Downloads/AI workflow improvements.md`.
6. **The dashboard plan describes an architecture that does not exist**
   (`lib/integrations/*`, section 5).

Checked and consistent: `SPEC.md` and `CONTEXT.md` agree on "block" (and
`CONTEXT.md` deprecates "node"); `delivery-gates.md` and `AGENTS.md` list the
same six commands.

### 7.3 Decision records

No ADR convention. Rationale lives in four incompatible formats:
`docs/assumptions/` (an "Assumption Ledger" table, used twice, abandoned
2026-07-03), one `*-decisions.md` plan, 28 `docs/superpowers/specs/*-design.md`
files (the de facto ADR store, unlinked), and 32 dated plans mixing decisions,
runbooks and incident write-ups. `README.md` links to none of them;
`AGENTS.md` links only to `delivery-gates.md`; `docs/SPEC.md` is reachable
from neither. Every rationale document is found by `ls`, never by a link.

A new agent needs about six documents to add a feature safely (`AGENTS.md`,
`delivery-gates.md`, `CONTEXT.md`, `SPEC.md`, `workflow-definitions.md`,
`SETUP.md`), and two of the six will mislead it.

### 7.4 Agent configuration against the Anthropic research

From `2026-09-09-agent-navigable-codebase.md`: the `CLAUDE.md -> @AGENTS.md`
bridge is correct (H1) and 105 lines is under the 200-line target; the
documented monorepo pattern (per-app `CLAUDE.md`, loaded lazily under H3) is
not used; `.claude/learnings.md` matches no loaded path (H2, H11) and is
inert; multi-step procedures (gate ladder, release) are skill-shaped, not
doc-shaped; `verify:changed` as a sentence is advisory where a hook would be
deterministic (H32); root `skills/` is a product artifact, not a Claude Code
location (H17), which is fine but must be stated somewhere.

---

## 8. What a reference monorepo does differently

`/Users/filip/Desktop/projekty/portivo` (12 apps, 22 packages, Go plus TS) was
read for transferable ideas only. Not transferable at this size: Turborepo, the
full oxlint/tsgolint/knip stack as a package deal, the 98 KB pre-push hook that
exists because CI is not required there either, and graphify (500 MB of
per-machine artifacts). Transferable, ranked:

1. **Package `description` is the contract**: one sentence saying what the
   package may and may not do (`packages/money/package.json`: "formatting only,
   never conversion"), quoted verbatim in the repo atlas.
2. **A gate is a dependency-free Node script with a baseline JSON and a header
   stating its exit condition** (`scripts/zod-import-gate.mjs:1-50`,
   `scripts/check-deps-consistency.mjs:1-33`). Ratchet down, never mass-fix.
3. **Granular `exports` maps, consumed as source, no build step**
   (`packages/mobile-storefront/package.json` has about 60 subpath entries).
4. **Contract chain by npm script** (`gen:api`) with a drift diff in the push
   hook and a breaking-change gate with a ratchet baseline
   (`scripts/openapi-breaking-gate.mjs`).
5. **Two lint tiers split by "may this fix run unattended"**
   (`.oxlintrc.precommit.json` extends `.oxlintrc.json`, type-aware off).
6. **`CLAUDE.md` as a routing table with a byte budget** (facts ->
   `AGENTS.md`, setup -> `SETUP.md`, procedures -> skills, prohibitions ->
   hooks, per-path rules -> `.claude/rules/`), plus the compaction rule that
   decides what lives where.
7. **`docs/adr/` in MADR form with a README index that says when to write one.**
8. **pnpm catalog plus a four-rule consistency check** even when the catalog is
   small.

Portivo has no mechanical import-boundary rule either; its boundaries are
prose in `AGENTS.md:25-44`. That is the one place this repo should go further
than the reference, because its cycle count says prose has not worked here.

---

## 9. Target shape

### 9.1 Principles

1. **Behaviour-neutral first.** Every stage below is a move, a fence, or a
   generator. No stage changes what a v2 run does. v1 retirement is the one
   deliberate behaviour change; the owner folded it into the plan as stage 3b
   on 2026-09-09 after production showed zero v1 definitions (plan D12, A11).
2. **Enforcement before structure.** A boundary that nothing checks is a
   comment. The first stage installs the checks with today's graph as the
   baseline, so every later stage can only ratchet down.
3. **A package earns its `package.json` by having two consumers.** Pure domain
   modules used by both apps become workspace packages. Modules with one
   consumer (the worker engine, the adapters, the DB layer) become fenced
   directories inside the worker, because a package boundary there buys
   nothing that dependency rules do not, and it fights WDK step discovery and
   Nitro bundling (see the boundary-enforcement research for the exact
   constraints).
4. **One file owns each concept.** Model catalog, block catalog, prompt
   defaults, price table: one module each, everything else derives from it,
   and a drift test proves it.
5. **Docs are either current, archived, or deleted.** Current documents are
   reachable in two hops from `README.md` or `AGENTS.md`. Archived documents
   sit under `docs/archive/` with a status line. Nothing else exists.

### 9.2 Workspace layout

```
apps/
  worker/                 Nitro shell. src/app holds routes, cron, webhooks,
                          mcp surface, auth wiring. Parse, validate, call a
                          service, respond. Never getDb(), never env.
  dashboard/              Next shell. Screens and UI kit. Domain logic only
                          through packages. One API client.
packages/
  contracts/              (today apps/shared/contracts) wire and domain types,
                          zod schemas, generated block catalog. Leaf.
  conditions/             (today apps/shared/conditions) pure evaluation.
  prompts/                slots, references, variables, composition, builtin
                          defaults, drift fixture. Pure. Both apps.
  harness/                profile manifest, capability catalog, THE model
                          catalog, skill manifest schema and lock format. Pure.
  costs/                  price table shape, usage aggregation, one cost
                          function for both providers, budget rules. Pure.
  workflow-graph/         v2 schema, validation, bindings, scheduler,
                          interpreter, layout, json-schema authoring. Pure.
```

Inside `apps/worker/src`, five fenced tiers:

```
app/        routes, cron, webhooks, mcp, middleware, plugins (Nitro srcDir)
services/   dispatch, run lifecycle, ticket transitions, overview read models,
            auth domain, publication (today: most of lib/)
engine/     blocks/, steps/, agent-workflow.ts, sandbox, pre-sandbox,
            pre-pr-checks, memory, clarifications, approvals, harness runtime,
            prompt runtime, run observability
adapters/   vcs, issue-tracker, messaging, agent-runtime, with one shared fake
            per interface
db/         schema per domain, migrations, repositories per domain,
            run-registry (today an "adapter" with one implementation)
config/     the single import point for env; everything else receives values
infra/      logger, telemetry, llm provider, crypto helpers (the ~6 pure
            infrastructure modules in lib/)
```

Allowed dependencies, top to bottom, no upward edges, no sideways edges except
where listed:

```
app        -> services, engine (only the workflow entrypoint), packages, config
services   -> engine, adapters, db, packages, infra
engine     -> adapters, db, packages, infra
adapters   -> packages, infra
db         -> packages/contracts, infra
config     -> nothing
infra      -> nothing
packages/* -> packages/contracts only (workflow-graph may use conditions)
```

Blocks become self-describing: one directory per block under `engine/blocks/`,
exporting a single `manifest` (type, params schema, contract, ui hints,
execute). Registry, executor map, `BLOCK_TYPE_SPECS` and the catalog are
generated from a directory scan into `packages/contracts/src/block-catalog.generated.ts`;
the existing `block-catalog-sync.test.ts` becomes a "generated file is up to
date" check and the HTML mock stops being a fixture.

### 9.3 Gates

Portivo's pattern applied minimally. All gates are plain Node scripts under
`scripts/gates/`, each with a header (why, exit condition), a baseline JSON
where a ratchet is needed, a test in `scripts/ci/`, and a single entry in both
`verify:changed` and `ci.yml`:

| Gate | Tool | Baseline |
|---|---|---|
| import boundaries and cycles | dependency-cruiser, rules for the tiers above | today's 28 cycles as known violations, ratcheted to zero by stage |
| unused files, exports, dependencies | knip | today's count |
| lint (both apps) | oxlint, correctness rules deny, rest warn | warnings counted, ratcheted |
| formatting | `git diff --check` in CI too | none |
| generated files current | block catalog, MCP contract, prompt drift, carry schema | none (already exist for three of four) |
| dependency consistency | pnpm catalog plus the four-rule check | none |
| required CI | branch protection on `main` requiring the `ci` job | repository setting, not code |

### 9.4 Documentation taxonomy

```
README.md              product entry; links the docs index
CLAUDE.md              @AGENTS.md (unchanged)
AGENTS.md              routing table under 200 lines: where is X, commands,
                       gate ladder pointer, conventions; nothing procedural
CONTEXT.md             glossary (linked from AGENTS.md)
SETUP.md               reference facts for humans; init-* skills are the
                       procedures and link to its sections; one direction only
apps/worker/CLAUDE.md  Nitro, WDK step discovery, migrations on build, the
                       300 s ceiling, neon-http has no transactions
apps/dashboard/CLAUDE.md
packages/CLAUDE.md
.claude/rules/*.md     path-scoped gotchas mined from learnings.md and memory
docs/
  index.md             the only list of current documents
  architecture/        overview (layers, allowed deps, one diagram), blocks
                       (how to add one), workflow-definition (v2, rewritten),
                       data-model (table ownership), gates
  adr/                 MADR records plus README index; first five:
                       layering and packages, block manifest, v1 retirement,
                       gates and required CI, docs taxonomy
  product/             SPEC.md, user-stories.md, roadmap
  runbooks/            releases/artur, GitHub app, GitLab, agent runtime
                       diagnostics, on-prem (with a status line)
  research/            as today
  archive/             plans, qa, testing, superpowers (all three trees),
                       assumptions, post-pr-gate-spec, pre-sandbox-plan,
                       security-observability, design-qa, learnings
```

Deleted, not archived: `.agents/skills/` (vendored, unreferenced),
`.kimi-code/` (local, diverged, untracked), `docs/workflow-workspace/index.html`
(replaced by the generated catalog).

---

## 10. Risks specific to this restructure

* **WDK discovery is content-based.** Moving a `"use step"` file to a path the
  builder does not scan fails at runtime, not at build. The existing
  `workflow-import-boundary.test.ts` is the guard; it must run in every stage
  that moves engine files, and the boundary-enforcement research decides
  whether steps may live outside `srcDir` at all.
* **`workflows/` churn.** 1277 file-touches in 90 days. Stages that move it
  need a short freeze on feature branches touching `apps/worker/src/workflows`,
  or they will conflict with everything in flight (see the memory note on
  sequential tickets producing conflicting PRs).
* **`build:shared` coupling.** Every command rebuilds the contracts package.
  Switching packages to source consumption removes the tax but changes how
  Nitro's Vercel tracer sees them; that is a research-gated decision.
* **Nothing is required on `main`.** Until branch protection exists, every
  gate in section 9.3 is advisory. The restructure should not start before that
  setting is flipped, because the first stage's whole value is that regressions
  cannot land.
* **Nitro 3 renames the scan root.** The pinned Nitro 2 uses `srcDir`; Nitro 3
  deprecates it for `serverDir`. An upgrade silently changes which directories
  the file router and WDK discovery scan. The discovery test must be part of
  any Nitro bump.
* **Migrations run during `build`.** `apps/worker/package.json` `build` calls
  `db:migrate`. Any stage that touches `db/` must keep that path working or
  the next preview deploy mutates a database.
