# End-to-End Test Plan: Graph Workflow Feature

Branch: `feat/workflow-editor-mvp`. Target: deployed preview **ai-workflow-demo**.

The human creates AWT tickets and moves them; the orchestrator authors/enables definitions in the editor and verifies each run through the deployed worker's `/api/v1/*` endpoints. No local worker runs at any point (reconciler collision on the shared Neon branch).

## Live deploy status (confirmed 2026-07-13)

- Worker deployed to `ai-workflow-demo` env, deployment `ai-workflow-oqdru7bpg`, status Ready.
- Env alias `ai-workflow-app-env-ai-workflow-demo-blazity.vercel.app`: `GET /api/v1/runs/block-statuses` and `GET /api/v1/runs/live` both return **401** (not 404/500), so the new code is serving, the DB has the new columns (migrations applied), and the compiled `@shared/*` packages resolve at runtime.
- The compiled-`@shared` architecture builds on Vercel (deploy exit 0), the key deploy risk is cleared.
- Test repo is pinned by env: `GITHUB_OWNER=blazity`, `GITHUB_REPO=ai-workflow-demo`, `GITHUB_BASE_BRANCH=main`. PRs can only land on **`blazity/ai-workflow-demo`**; substitute that repo everywhere below.
- Provider: `CLAUDE_MODEL=claude-haiku-4-5`. `ANTHROPIC_API_KEY` is invalid/pending, so claude-pinned blocks fail early (a valid negative test); codex-only tiers are unblocked once `CODEX_API_KEY`/`CODEX_MODEL` are confirmed.
- GitHub App id `3632887` is configured; verify its installation is scoped so it can only touch `blazity/ai-workflow-demo`.

## 0. Ground rules baked into every test

- **Single enabled definition per trigger type** (`store.ts assertNoTriggerOverlap`, 409). Only ONE `trigger_ticket_ai` definition may be enabled at a time. Tiers that need a different ticket-trigger shape must **disable the prior one, then enable the new one**. PR-trigger and plan-approved definitions use different trigger types, so they can be enabled alongside a ticket-trigger definition.
- **Version guard for live dots** (`apps/dashboard/lib/workflow-editor/run-statuses.ts:14-15`): the canvas shows dots only when the block-status snapshot's `definitionId` AND `definitionVersion` both equal the editor's selected head. **Never save/edit a definition while a run against it is in flight**, a version bump makes the dots vanish (this is itself a Tier 6 test; elsewhere it is a caution).
- **Agent blocks need a workspace.** `planning_agent`/`implementation_agent`/`review_agent`/`fix_agent` return `no workspace: connect prepare_workspace before <type>` if `ctx.sandboxId` is null (`agent.ts`). The loader injects a virtual `prepare_workspace` only for the V1 linear default. **Every custom definition containing an agent block must include an explicit `prepare_workspace` node** unless it is the untouched linear default.
- **Every PR-opening definition/ticket must target `blazity/ai-workflow-demo`.** Clarification answers that name a repo must hard-constrain it to the test repo.
- **Cheap models only** in test definitions: `gpt-5.4-nano` for planning/research, `gpt-5.4-mini` for implementation.
- **Trigger nodes never appear in `block_statuses`** (seeded from non-trigger nodes only). Gate/post-PR runs never write `block_statuses`, and `blocked` runs are excluded.

## 1. Prerequisites checklist

### 1a. Environment (Vercel env on ai-workflow-demo)
| Var | Tier 0-4, 6, 7 (codex) | Tier 5 positive + provider-mix |
|---|---|---|
| `AGENT_KIND` | `codex` | `codex` (run default), claude via per-block |
| `CODEX_MODEL` | `gpt-5.4-mini` | same |
| `CODEX_API_KEY` | valid | valid |
| `ANTHROPIC_API_KEY` | invalid/pending (enables the fail-early NEGATIVE test) | **must be rotated to valid** before positive claude tests |
| `CLAUDE_MODEL` | set (`claude-haiku-4-5`) | valid model id |
| `DATABASE_URL` (Neon) | per-environment branch, **not** shared with local | same |
| `MAX_CONCURRENT_AGENTS` | known value (needed for at-capacity/503 test) | same |
| `VCS_BOT_LOGIN` | the bot's login (drives bot-PR gate precedence) | same |
| Jira | `JIRA_BASE_URL`, `JIRA_PROJECT_KEY`, `COLUMN_AI_REVIEW`, `COLUMN_BACKLOG`, transitions for AWT board | same |
| Slack | bot token, channel id | same |
| GitHub App | scoped to `blazity/ai-workflow-demo` only | same |

### 1b. Registrations / access
- Dashboard login with **editor/admin** role (required for `workflow-definitions` POST/PUT/PATCH/DELETE and `approvals` approve/reject). Capture the session cookie once; reuse for all `/api/v1` reads and writes.
- Jira webhook registered so entering the AI column fires `trigger_ticket_ai`.
- GitHub webhook on `blazity/ai-workflow-demo`, normalized to `trigger_pr_created` / `trigger_pr_checks_failed` / `trigger_pr_review`.
- `/health` OK on the preview; editor page loads.

### 1c. Definitions to author up front (author all; enable per the sequencing column)
| Key | Shape (fixture analog) | Trigger types | When enabled |
|---|---|---|---|
| **D0 Smoke Linear** | V1 `linearPipelineDefinition` (untouched default) | `trigger_ticket_ai` | Tier 0, 1 (block-swaps), 2, negative tests |
| **D-Ctrl** | V2 `humanGateLoopDefinition` variants | `trigger_ticket_ai` | Tier 2 (swap in for D0) |
| **D-Approval** | V3 `planApprovalDefinition` | `trigger_ticket_ai` + `trigger_plan_approved` | Tier 3 |
| **D-PRfix** | V4 `prReviewFixDefinition` | `trigger_pr_checks_failed` + `trigger_pr_review` | Tier 4 (alongside a ticket def) |
| **D-PRcreated** | `fetch_pr_context -> post_pr_comment` | `trigger_pr_created` | Tier 4 gate-precedence |

## 2. Test matrix (simple -> complex)

Notation: `A -> B` default port; `A --true--> B` named port. Params in `{}`. Ports are fixed by `BLOCK_TYPE_SPECS`: `branch` = `true`/`false`; `loop` = `continue`/`exhausted`; action blocks = `out` (+ optional `failed` failure port when `allowsFailurePort`); `send_plan_approval` and `terminate` are terminal.

Baseline block-status progression to assert on every agent run (poll `GET /api/v1/runs/block-statuses?definitionId=<id>`): each non-trigger node goes `pending -> running -> ok`; `source` is `"live"` while a registry entry exists, then `"last"` after completion; snapshot `status` ends `success`.

### TIER 0 - Smoke (D0 Smoke Linear enabled)

**T0.1 - Trivial ticket end-to-end**
- Definition: **D0** untouched: `trigger -> planning -> implementation -> checks -> open-pr -> status{target:"ai_review"} -> slack`.
- Ticket: title "Add greeting line to README"; description "In repo **blazity/ai-workflow-demo**, append the line `Hello from Blazebot smoke test` to the end of README.md. Do not touch any other file."; acceptance "README.md ends with that exact line; PR opened." Move into the AI column.
- Verify:
  - `GET /api/v1/runs/live` -> a row for this ticket, `status` running, `model` = `gpt-5.4-mini`.
  - `GET /api/v1/runs/block-statuses?definitionId=<D0>` -> `pending->running->ok` for `planning, implementation, checks, open-pr, status, slack`; `definitionId`/`definitionVersion` match D0 head; editor canvas shows the moving dot + status bar.
  - `GET /api/v1/runs/<runId>` -> `available:true`; `phases` has `Research` and `Impl` (and `Review` if enabled) each with `costUsd`,`tokens`,`durationMs`,`numTurns`; `model` = impl model; `costKnown:true`; `costUsd > 0`; `prUrl`/`prNumber` on the test repo.
  - PR exists with only the README change; ticket moved to `COLUMN_AI_REVIEW`.
  - Slack: `started` then `pr_ready`.
  - `GET /api/v1/cost` -> `totals.traceCount >= 1`, cost reflected under the Agent workflow.

### TIER 1 - Per-block + params (sequential edits of a dedicated **D1** ticket-trigger def; disable D0 first; each PUT bumps version)

**T1.1 generic_agent** - `trigger -> prepare_workspace -> generic{prompt:"List the top-level files of the repo as JSON.", outputSchema:'{"type":"object","properties":{"files":{"type":"array"}}}', model:"gpt-5.4-nano"} -> post_ticket_comment{body:"done"}`. Verify generic phase present; block `ok` with `output.status:"ok"`. Invalid-schema variant (`outputSchema:"{"`) -> block `fail`, `error:"invalid outputSchema"`.

**T1.2 call_llm** - `trigger -> call_llm{prompt:"Reply with the single word READY.", model:"gpt-5.4-nano"} -> post_ticket_comment{body:"llm ok"}`. Block `ok`; missing-prompt variant -> `fail` `"call_llm requires a prompt"`.

**T1.3 run_checks (report-only)** - `... implementation -> run_checks{commands:["ls","exit 1"]} -> open_pr ...`. Non-zero command still returns `ok` (report-only) and run continues to open_pr.

**T1.4 post_ticket_comment** - verify `output.commentUrl` present and comment visible on the ticket.

**T1.5 update_ticket_status** - end with `update_ticket_status{target:"backlog"}`; ticket lands in that column; block `ok`.

**T1.6 prepare/finalize workspace** - `trigger -> prepare_workspace -> implementation -> finalize_workspace{requiredChecks:[]} -> post_pr_comment{...}` (finalize publishes). Both workspace blocks `ok`; a branch/commit pushed.

**T1.7 fetch_pr_context + post_pr_comment** - deferred to Tier 4 (needs a real PR).

### TIER 2 - Control flow (enable **D2**; disable D1)

**T2.1 branch, both paths on `steps.checks.output.ok`** - `trigger -> prepare_workspace -> implementation -> checks -> verdict(branch{condition:"steps.checks.output.ok"})`; `verdict --true--> open_pr -> terminate{done}`; `verdict --false--> post_ticket_comment{body:"checks failed"} -> terminate{skipped}`. True-path ticket (valid change): `verdict` `ok`, `output.path:"true"`, reaches open_pr. False-path ticket (fails checks): `output.path:"false"`, reaches comment + skipped terminate.

**T2.2 loop, all three onExhaust modes** - base `... verdict --false--> retry(loop{maxAttempts:3}) --continue--> fix(review_agent) -> checks`; `verdict --true--> open_pr`.
- 2a `onExhaust:"fail"`: checks never pass. `retry.attempt` increments live (1->2), after 3 attempts run fails via `failureExit`; block `fail`.
- 2b `onExhaust:"human"`: exhaustion -> `clarificationExit` (needs_human_input), ticket parked to backlog, Slack `needs_clarification`, block `warn`.
- 2c `onExhaust:"continue"`: wire the `exhausted` port -> `post_ticket_comment{body:"gave up gracefully"} -> terminate{done}`. Run continues past the loop, `output.status:"exhausted"`, block `ok`.

**T2.3 terminate, each terminal_status** - four tails after a branch: `done`, `skipped`, `waiting_for_human`, `failed`. `done`/`skipped` -> block `ok`, run `success`, ticket not moved. `waiting_for_human` -> block `warn`, clarification + ticket to backlog, run `success`. `failed` -> block `fail`, ticket to backlog, Slack `failed`, run `failed`.

**T2.4 failure-edge override** - `... implementation --failed--> post_ticket_comment{body:"impl failed, handled"} -> terminate{skipped}` plus `implementation --out--> open_pr`. Ticket engineered to fail impl. Run routes down `failed` port; `implementation` block `fail` but run reaches comment; run `success` via `skipped`.

### TIER 3 - HITL

**T3.1 clarification loop (end-and-re-enter)** - enable D0/D1. Ambiguous but repo-constrained ticket ("In blazity/ai-workflow-demo, rename the greeting constant, but I haven't decided the new name"). First run: agent block `warn`; run `success` (clarificationExit); Jira shows numbered questions; ticket to `COLUMN_BACKLOG`; Slack `needs_clarification`; `runs/live` shows it under awaiting. Human answers hard-constraining the repo and moves back to AI column -> **new run** (new runId) proceeds to PR.

**T3.2 human_question block** - `trigger -> prepare_workspace -> planning -> human_question{questions:["Confirm the target filename?"]} -> implementation -> ...`. `human_question` returns `needs_human_input` -> park-and-re-enter; block `warn`. Missing-questions-and-no-upstream variant -> block `fail`.

**T3.3 plan approval (V3)** - enable **D-Approval** (disable other ticket-trigger defs first). `trigger-ticket -> planning -> send-approval(send_plan_approval{mirrorComment:true})`; `trigger-approved -> implementation -> open-pr -> status{ai_review}`. Chain 1 ends at send-approval with `output.status:"awaiting_approval"` + `approvalRequestId`; block `warn`; run `success`; Slack `plan_approval_requested`; ticket parked + awaiting-approval label; `GET /api/v1/approvals?status=all` lists it pending. Approve on the dashboard -> `POST /api/v1/approvals/<id>/approve` -> **second run** from `trigger_plan_approved`; PR opened; mirror comment posted; approval flips to non-pending.

### TIER 4 - Triggers (enable **D-PRfix** and **D-PRcreated**; keep a ticket def enabled too, different trigger types)

Setup: first produce a bot-owned PR whose head branch encodes an AWT ticket key (run T0.1 to open one).

**T4.1 pr_checks_failed / pr_review -> pr_trigger fix run** - D-PRfix: `trigger_pr_checks_failed`/`trigger_pr_review -> fetch_pr_context -> prepare_workspace -> fix_agent -> finalize_workspace -> post_pr_comment{body:"Automated fix pushed. Please re-review."}`. Trigger a failing check (or request changes). `runs/live` shows `run_kind` `pr_trigger`; block-statuses progress; new commit pushed to PR branch; comment posted; webhook `{status:"dispatched", runId}`.

**T4.2 gate precedence** - D-PRcreated enabled; bot PR (branch encodes ticket key) -> definition run supersedes gate (log `post_pr_gate_superseded_by_definition`). Non-bot PR or no matching def -> falls through to the gate.

**T4.3 coalescing** - two PR-review webhooks for the same branch while the first run is active -> second returns `coalesced`/`already_claimed`; only one run row.

**T4.4 at-capacity -> durable recovery** - saturate `MAX_CONCURRENT_AGENTS`, fire a PR webhook -> HTTP **503** `trigger_at_capacity`; the durable accepted delivery remains recoverable and the local poller dispatches it after capacity returns. Provider redelivery is idempotent but is not required; no lost event.

**T4.5 pr_trigger run not cancelled on AI-column move** - with a `pr_trigger` run active, move its ticket out of the AI column -> run NOT cancelled (run_kind exempt), contrast T7.3.

### TIER 5 - Providers + cost (needs valid ANTHROPIC_API_KEY for positive claude rows)

**T5.1 codex pricing / costKnown=true** - any Tier 0 codex run: `costKnown:true`, `costUsd>0`, `phases[*].costUsd` present.

**T5.2 costKnown=false** - force a phase timeout so a launched phase records no usage: `costKnown:false`; run still `available`.

**T5.3 per-block provider mixing** - `planning{provider:"claude", model:"claude-haiku-4-5"} -> implementation{provider:"codex", model:"gpt-5.4-mini"}`. Block param wins; `phases` shows Research under claude, Impl under codex; `workflow_runs.model` = impl block's model. Label override: no block provider + label `agent:codex` flips the run default; env `AGENT_KIND` is the final fallback.

**T5.4 "Impl #2" on re-execution** - run a fix-cycle definition; `phases` contains a second key suffixed ` #2`, each with its own model+cost+tokens.

### TIER 6 - Multiple definitions + editor (via `GET/POST/PUT/PATCH/DELETE /api/v1/workflow-definitions`)

**T6.1 create/duplicate/rename/enable/delete** - `POST {name, source:{kind:"default"}}` -> new def, disabled, v1. `POST {source:{kind:"duplicate", definitionId}}` seeds from head. `PATCH {name}` renames. `PATCH {enabled:true}` enables. `DELETE` archives (only when disabled and not the last).

**T6.2 enabled-per-trigger conflict -> 409** - enabling a second `trigger_ticket_ai` def -> 409. Name collision -> 409.

**T6.3 archive edge cases -> 409** - archive an enabled def -> 409; archive the last def -> 409.

**T6.4 version history / restore** - `PUT` several times; `POST /<id>/restore {version:N}` creates a new version with `restoredFromVersion:N`.

**T6.5 live-status version guard** - start a run, `PUT` mid-run (bump version) -> dots disappear; selecting a different definition also blanks them; re-selecting the exact running version restores them.

**T6.6 save-validation errors** - `PUT` invalid graphs rejected: cycle without a loop; branch half-wired (only `true`); loop missing `continue`; `onExhaust:"continue"` missing `exhausted`; model string violating `^[A-Za-z0-9._:\/-]+$`.

### TIER 7 - Negatives / edge

**T7.1 missing provider key fail-early (runs TODAY)** - `planning{provider:"claude"}` while ANTHROPIC key invalid -> phase fails early; run `failed`; block `fail`; Slack `failed`. Unblocks Tier 5 positives once the key is rotated.

**T7.2 invalid graph rejected on save** - multiple triggers of one type; trigger with incoming edge; zero triggers; branch condition referencing a non-ancestor step.

**T7.3 ticket leaving AI column cancels ticket-kind run** - start a normal run, move the ticket out -> run cancelled -> `status:blocked` (contrast T4.5). `blocked` runs excluded from block-statuses.

**T7.4 approval negatives (409)** - duplicate approve; superseded approval; definition disabled at approve time.

**T7.5 execution cap** - a definition that loops enough to exceed 200 block executions -> `failureExit("engine", "workflow exceeded the maximum of 200 block executions")`; run `failed`.

## 3. Observing a run WITHOUT a local poller

The deployed worker persists telemetry from inside the workflow (`recordBlockStatuses`, `recordRunUsage`), independent of the cron, so the orchestrator only polls the deployed worker's `/api/v1/*` (authenticated with the dashboard session cookie). Do NOT start a local worker.

- **Live progression** - poll `GET /api/v1/runs/block-statuses?definitionId=<selected>` every ~5 s. Each node `pending -> running -> ok`; `attempt` increments for loop/fix re-execution; `warn` = HITL/plan-approval park; `fail` = failure; `error` carries the message; `source` `"live"` then `"last"`. Always pass `definitionId`.
- **Live list / awaiting** - `GET /api/v1/runs/live` (running rows with `model`, plus awaiting rows).
- **Cost/model per phase** - `GET /api/v1/runs/<runId>`: `run.model` (= impl block model), `costUsd`, `costKnown`, token fields, and `phases` jsonb; loop/fix adds ` #2` keys. `GET /api/v1/cost?window=...` aggregates.
- **PR + ticket lifecycle** - `runs/<runId>.prUrl`/`prNumber` (confirm on `blazity/ai-workflow-demo`); Jira column transitions; Slack `started`/`needs_clarification`/`pr_ready`/`failed`/`canceled`/`plan_approval_requested`.
- **Approvals** - `GET /api/v1/approvals?status=all`; approve via `POST /api/v1/approvals/<id>/approve`.
- **Definitions** - `GET /api/v1/workflow-definitions` and `/<id>` for enabled/trigger/version state.
- **Webhook responses** - capture the HTTP status/body the provider receives.

## 4. Known blockers before full coverage

1. **ANTHROPIC_API_KEY invalid/pending** - blocks positive Claude tests (Tier 5 provider-mix positive rows, any claude-pinned success path). Workaround: run T7.1 now; rotate the key, then run Tier 5 positives. Codex-only coverage (Tiers 0-4, 6, 7) is unblocked.
2. **GitHub App scope** - verify installation is locked to `blazity/ai-workflow-demo` only. The worker already only acts on `GITHUB_OWNER`/`GITHUB_REPO`, but confirm the App cannot reach other repos. Blocks PR-opening tiers until confirmed.
3. **Shared demo DB (Neon branch-sharing)** - direct DB queries are unreliable because the demo DB branch is shared with local. Read state only through the deployed worker's `/api/v1/*`; never run a local worker/poller concurrently.
4. **Dashboard UI access / auth origin** - the demo worker's Better Auth trusts a single `DASHBOARD_ORIGIN`. To use the editor/Approvals UI against the demo worker, the UI's origin must equal that value. Decide: deploy the dashboard branch to a stable preview alias and point `DASHBOARD_ORIGIN` at it, or drive authoring/verification via the `/api/v1` endpoints directly. This affects a shared env, so it is a setup decision to make before UI-dependent tiers (0 dots, 3 approvals, 6 editor).
5. **Single-enabled-per-trigger constraint** - not a defect but a sequencing rule: serialize ticket-trigger tiers (disable prior, enable next). PR-trigger and plan-approved defs can run concurrently.
