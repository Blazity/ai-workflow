# Workflow Editor: Phase 2 Plan

Date: 2026-07-10
Status: **Shipped.** Backlog items 1-8 below are all implemented on `feat/workflow-editor-mvp` and live-exercised on the demo. This doc is kept as the record of what phase 2 set out to do and what it turned into; it is no longer a to-do list.
Branch context: phase 1 + phase 2 are on `feat/workflow-editor-mvp` (74 commits as of 2026-07-15, still not merged to main). The "7 commits" below was phase 1's count on 2026-07-10.

> **Status update (2026-07-15).** Every backlog item shipped, and the engine went well past this plan: runs now execute an arbitrary graph of **27 block types** (`apps/shared/contracts/domain.ts`, `WorkflowBlockType`), not the 8 blocks phase 1 shipped. All 27 were exercised on real runs on 2026-07-14 (`docs/testing/e2e-test-report.md`), and the deterministic suite is at **1536 passing across 132 files** (2026-07-15), up from the 823 recorded below. Per-item notes are inline. The format and block catalog are documented in `docs/workflow-definitions.md`.

## Phase 1 recap (done and verified)

- Functional drag&drop workflow editor in the dashboard: palette of 8 runtime-real blocks, per-block config, per-agent-block model selection (dynamic model lists from Anthropic/OpenAI APIs + custom value), versioned definitions in Postgres with history and rollback, graph validation on save, read-only mode for non-editor roles.
- Worker executes runs from the stored definition (interpreter in `agentWorkflow`, fallback to built-in default, per-phase model telemetry).
- Tests: worker 823/823, dashboard 33/33, both typechecks clean (phase-1 figures; the worker suite is **1536/1536 across 132 files** as of 2026-07-15). Structural parity with the previous hardcoded pipeline confirmed in review.
- End-to-end dogfooding on the demo deployment (AWT-1007): AI-column trigger, research on `gpt-5.4-nano` (model from definition), clarification loop (question, label, backlog, human answer, resume), implementation on `gpt-5.4-mini`, checks, PR opened, ticket moved to AI Review. Review phase correctly absent (not in the definition).

## Phase 2 backlog (priority order): all shipped

Each item keeps its original text, with an outcome line appended.

1. **Live run tracking on the editor canvas**: feed the existing `runStatuses` overlay in `flow-editor.tsx` with real per-block status during a run (per-phase data already lands in `workflow_runs.phases`; dashboard has a live endpoint pattern in `runs/live.get.ts`).
   - ✅ **Shipped.** Per-block status renders live on the canvas, the running block glows, and the header names the current step. Verified live (`e2e-test-report.md` section 3).
2. **Per-block provider selection (Claude Code / Codex)**: add a `provider` param on agent blocks next to `model`; the model dropdown switches lists by provider (both lists already fetched in `workflow-definition/models.ts`). Engine work: configure BOTH agent CLIs in the sandbox at provisioning (today only the active one is installed: `sandbox/agents/claude.ts` / `codex.ts`), validate both providers' keys, per-block cost attribution (Codex LiteLLM pricing vs Claude), extend Zod schema and shared contracts. Stepping stone to OpenRouter (provider becomes a model prefix).
   - ✅ **Shipped.** `provider: z.enum(["claude","codex"]).optional()` sits next to `model` on the agent-block params (`workflow-definition/schema.ts:37`), and `prepare_workspace` provisions every agent CLI the definition can need by scanning its agent nodes (`requiredKindsForDefinition`), validating each kind's API key. OpenRouter remains a future idea, not done.
3. **Custom selects instead of native ones**: `ModelField` and the status-target select in `NodeConfig` are bare `<select>` elements; build a cockpit-styled generic listbox (the removed `FlowSelect` from the old mock had a keyboard-accessible listbox: see git history of `flow-editor.tsx` before commit `7288f7f`).
   - ✅ **Shipped.** `apps/dashboard/components/cockpit/listbox.tsx` is the shared cockpit listbox, used by the flow editor's config fields and across the cockpit screens.
4. **Multiple workflow definitions**: list + active-definition selector (today: one global definition). Prerequisite for the V1-V4 variants.
   - ✅ **Shipped.** Full definition CRUD + lifecycle (`routes/api/v1/workflow-definitions/`): create, duplicate, save-version, rename, enable, archive, version history, restore, with one enabled definition per trigger type. The e2e campaign ran ~15 distinct definitions.
5. **Control blocks: Branch + Loop** (spec variant V2): explicit status-based branching and a loop with an `exhausted` port; extend the graph validator (`workflow-definition/schema.ts`) and the interpreter (`workflows/agent.ts`).
   - ✅ **Shipped.** `branch`, `loop` and `terminate` are walked inline by the interpreter; the validator gained cycle-without-loop and port-wiring rules. All three live-exercised.
6. **PR triggers** (spec variant V4): route PR webhooks into agent runs; absorb the post-PR gate into workflow definitions (deprecate `post-pr-gate.yaml`, spec guarantee #6).
   - ✅ **Shipped.** `trigger_pr_created`, `trigger_pr_checks_failed` and `trigger_pr_review`, all three live-exercised on real PRs. `post-pr-gate.yaml` is deprecated (gate precedence: a matched enabled definition on a bot PR supersedes it; the gate still handles non-bot PRs and PRs with no matching definition). Documented in `docs/workflow-definitions.md`.
7. **Plan approval / durable wait** (spec variant V3): HITL blocks; requires the suspend vs end-and-re-enter decision (research recommendation: end-and-re-enter, matching today's clarification loop).
   - ✅ **Shipped**, with end-and-re-enter as recommended: `send_plan_approval` parks the run and writes an `approval_requests` row; approving it dispatches a fresh `trigger_plan_approved` run carrying the approved plan. `human_question` shipped alongside. Full park → approve → resume chain demonstrated live.
8. **Remaining registry blocks**: Generic Agent, Workspace prepare/finalize (requires Vercel Sandbox SDK v2 migration for persistent warm/cold workspaces), Call LLM, remaining ticket/VCS actions.
   - ✅ **Shipped** as blocks: `generic_agent`, `prepare_workspace`, `finalize_workspace`, `call_llm`, plus the ticket/VCS actions (`post_ticket_comment`, `update_ticket_status`, `open_pr`, `post_pr_comment`, `fetch_pr_context`). The sandbox is still provisioned per run and torn down in `finally`; the persistent warm/cold workspace ambition (and any Sandbox SDK v2 migration) was **not** part of what shipped and remains open.

## Operational follow-ups (independent of the backlog)

- Replace `ANTHROPIC_API_KEY` in the `ai-workflow-demo` Vercel environment with the rotated key (until then the demo runs Codex: `AGENT_KIND=codex`, `CODEX_MODEL=gpt-5.4-mini`, `CODEX_API_KEY` set on 2026-07-10).
- ✅ **Done (the allowlist half).** Restrict the bot's GitHub App installation (or add a repo allowlist) so test runs cannot open PRs on public repos (a test run opened a PR on public `next-saas-starter`; cleaned up). Product note: a human clarification answer naming a repo should hard-constrain repo selection, not just inform the agent.
  - `3001732` added the `AGENT_ALLOWED_REPOS` guard (`lib/repo-allowlist.ts`): it filters repository discovery and hard-guards branch/PR creation, and held on every run of the e2e campaign (every run selected only `github:Blazity/ai-workflow-demo`). Note it **fails open**: empty/unset = every installed repo is allowed, so it is defense-in-depth and not a substitute for scoping the App installation. Documented in `SETUP.md`. The product note about clarification answers hard-constraining repo selection is still open.
- Demo runtime database mystery: the deployed runtime writes to a different database than the static `DATABASE_URL` env value (build used the main branch, runtime did not; suspected Neon integration preview branching). Needs a look in the Neon console; affects dashboard visibility of demo runs.
- WDK local-dev bug: `Dynamic require of @slack/web-api` in the steps bundle poisons module init (`PostgresRunRegistry is not a constructor`). Working workaround: Node loader hook in `apps/worker/scripts/wdk-require-hook.mjs` + `apps/worker/scripts/wdk-require-register.mjs`, launched via `NODE_OPTIONS="--import .../wdk-require-register.mjs" pnpm dev`. Report upstream (workflow 4.2.5; check whether 4.6.0 fixes it).
  - Path correction: this originally read `apps/worker/.vercel/wdk-require-hook.mjs`, which could never have been committed because `.vercel` is gitignored. The committed scripts live in `apps/worker/scripts/`.
  - ⚠️ **Manual-only:** no npm script references either file, so the hook loads only if a dev passes `--import` by hand. Anyone hitting this error in local dev will not get the workaround automatically.
- The deployed instance's reconciler kills local runs' claims (3 unreachable strikes) and its failure path moves tickets and stops sandboxes by branch name: local dogfooding against a live demo instance is structurally impossible. Test by deploying the branch to the demo environment instead (`vercel deploy --target=ai-workflow-demo --yes --scope blazity` from the repo root; project rootDirectory is `apps/worker`). Add to learnings/README.
- Design board fixes from the AIW-83 review: missing Prev/Next sidebar controls; registry frame does not get a dedicated full-width row in `packFrames` (`docs/workflow-workspace/index.html`).
- Jira board cleanup: AWT-1006 (broken after trash restore, invisible to the bot) and AWT-1007 (in AI Review).
- The dashboard deployment (`ai-workflow-app-dashboard`) still serves the old mock editor from main; the new editor is visible locally (worker :3100 + dashboard :3001) or after deploying the dashboard branch.

## Working process

Implementation runs with the advisor + Opus executors + reviewer-gate process (user-level skill `opus-orchestration`): Fable plans, briefs and gates; Opus executors implement disjoint-scope stages; a separate reviewer verifies each stage before the advisor commits.
