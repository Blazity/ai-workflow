# Workflow Editor: Phase 2 Plan

Date: 2026-07-10
Status: Backlog agreed, detailed planning pending.
Branch context: phase 1 shipped on `feat/workflow-editor-mvp` (7 commits, not merged to main).

## Phase 1 recap (done and verified)

- Functional drag&drop workflow editor in the dashboard: palette of 8 runtime-real blocks, per-block config, per-agent-block model selection (dynamic model lists from Anthropic/OpenAI APIs + custom value), versioned definitions in Postgres with history and rollback, graph validation on save, read-only mode for non-editor roles.
- Worker executes runs from the stored definition (interpreter in `agentWorkflow`, fallback to built-in default, per-phase model telemetry).
- Tests: worker 823/823, dashboard 33/33, both typechecks clean. Structural parity with the previous hardcoded pipeline confirmed in review.
- End-to-end dogfooding on the demo deployment (AWT-1007): AI-column trigger, research on `gpt-5.4-nano` (model from definition), clarification loop (question, label, backlog, human answer, resume), implementation on `gpt-5.4-mini`, checks, PR opened, ticket moved to AI Review. Review phase correctly absent (not in the definition).

## Phase 2 backlog (priority order)

1. **Live run tracking on the editor canvas**: feed the existing `runStatuses` overlay in `flow-editor.tsx` with real per-block status during a run (per-phase data already lands in `workflow_runs.phases`; dashboard has a live endpoint pattern in `runs/live.get.ts`).
2. **Per-block provider selection (Claude Code / Codex)**: add a `provider` param on agent blocks next to `model`; the model dropdown switches lists by provider (both lists already fetched in `workflow-definition/models.ts`). Engine work: configure BOTH agent CLIs in the sandbox at provisioning (today only the active one is installed: `sandbox/agents/claude.ts` / `codex.ts`), validate both providers' keys, per-block cost attribution (Codex LiteLLM pricing vs Claude), extend Zod schema and shared contracts. Stepping stone to OpenRouter (provider becomes a model prefix).
3. **Custom selects instead of native ones**: `ModelField` and the status-target select in `NodeConfig` are bare `<select>` elements; build a cockpit-styled generic listbox (the removed `FlowSelect` from the old mock had a keyboard-accessible listbox: see git history of `flow-editor.tsx` before commit `7288f7f`).
4. **Multiple workflow definitions**: list + active-definition selector (today: one global definition). Prerequisite for the V1-V4 variants.
5. **Control blocks: Branch + Loop** (spec variant V2): explicit status-based branching and a loop with an `exhausted` port; extend the graph validator (`workflow-definition/schema.ts`) and the interpreter (`workflows/agent.ts`).
6. **PR triggers** (spec variant V4): route PR webhooks into agent runs; absorb the post-PR gate into workflow definitions (deprecate `post-pr-gate.yaml`, spec guarantee #6).
7. **Plan approval / durable wait** (spec variant V3): HITL blocks; requires the suspend vs end-and-re-enter decision (research recommendation: end-and-re-enter, matching today's clarification loop).
8. **Remaining registry blocks**: Generic Agent, Workspace prepare/finalize (requires Vercel Sandbox SDK v2 migration for persistent warm/cold workspaces), Call LLM, remaining ticket/VCS actions.

## Operational follow-ups (independent of the backlog)

- Replace `ANTHROPIC_API_KEY` in the `ai-workflow-demo` Vercel environment with the rotated key (until then the demo runs Codex: `AGENT_KIND=codex`, `CODEX_MODEL=gpt-5.4-mini`, `CODEX_API_KEY` set on 2026-07-10).
- Restrict the bot's GitHub App installation (or add a repo allowlist) so test runs cannot open PRs on public repos (a test run opened a PR on public `next-saas-starter`; cleaned up). Product note: a human clarification answer naming a repo should hard-constrain repo selection, not just inform the agent.
- Demo runtime database mystery: the deployed runtime writes to a different database than the static `DATABASE_URL` env value (build used the main branch, runtime did not; suspected Neon integration preview branching). Needs a look in the Neon console; affects dashboard visibility of demo runs.
- WDK local-dev bug: `Dynamic require of @slack/web-api` in the steps bundle poisons module init (`PostgresRunRegistry is not a constructor`). Working workaround: Node loader hook in `apps/worker/.vercel/wdk-require-hook.mjs` + `wdk-require-register.mjs`, launched via `NODE_OPTIONS="--import .../wdk-require-register.mjs" pnpm dev`. Commit as a dev tool and report upstream (workflow 4.2.5; check whether 4.6.0 fixes it).
- The deployed instance's reconciler kills local runs' claims (3 unreachable strikes) and its failure path moves tickets and stops sandboxes by branch name: local dogfooding against a live demo instance is structurally impossible. Test by deploying the branch to the demo environment instead (`vercel deploy --target=ai-workflow-demo --yes --scope blazity` from the repo root; project rootDirectory is `apps/worker`). Add to learnings/README.
- Design board fixes from the AIW-83 review: missing Prev/Next sidebar controls; registry frame does not get a dedicated full-width row in `packFrames` (`docs/workflow-workspace/index.html`).
- Jira board cleanup: AWT-1006 (broken after trash restore, invisible to the bot) and AWT-1007 (in AI Review).
- The dashboard deployment (`ai-workflow-app-dashboard`) still serves the old mock editor from main; the new editor is visible locally (worker :3100 + dashboard :3001) or after deploying the dashboard branch.

## Working process

Implementation runs with the advisor + Opus executors + reviewer-gate process (user-level skill `opus-orchestration`): Fable plans, briefs and gates; Opus executors implement disjoint-scope stages; a separate reviewer verifies each stage before the advisor commits.
