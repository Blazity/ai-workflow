# E2E Test Findings: Graph Workflow Feature

Branch `feat/workflow-editor-mvp`, tested against the deployed **ai-workflow-demo** preview.
Method: worker `/api/v1/*` for authoring/verification; Jira tickets (AWT board) via browser for run triggers.

Status legend: ✅ verified · ⛔ blocked · 🐞 bug · ⚠️ caution/observation.

---

## 0. Executive summary

- ✅ 🐞 **P0 blocker found AND fixed (validated live).** Every workflow-definition write (create/save/enable/archive) + approval creation returned **HTTP 500** on the deployed worker: `No transactions support in neon-http driver` (the store used `db.transaction`, prod runs neon-http; unit tests missed it because they use the transaction-capable pglite driver). Fixed on the branch by removing interactive transactions (per-statement writes + PK-retry + constraint guarantees, no driver switch — required because the run/approval paths run in Workflow-DevKit step bundles that need the fetch-based neon-http client). Redeployed to preview and re-tested live: create/duplicate 200, save 200, enable-conflict 409, rename-collision 409, archive-enabled 409, version history + restore 200, delete 200, and the graph validator rejects every malformed graph with the exact 400 message — **effectively 25/25** (3 apparent misses were the test harness matching un-escaped quotes against a JSON-escaped body; the real messages, e.g. `Branch "b" must have its "false" port connected.`, are correct). The demo was left clean (def 1 still enabled, scratch defs deleted). See §1.
- ⛔ **Browser not connected — the one remaining blocker.** The Claude-in-Chrome extension reports 0 connected browsers, so Jira test tickets (the run trigger) can't be created. This blocks only the **run-execution** tiers (agents/PR/cost). Real runs need real AWT tickets, and per the goal those are created via Chrome. Everything not needing a run trigger is now testable via API and largely done.
- ✅ Read paths work: sign-in (200), `GET /api/v1/workflow-definitions` and `/runs/live` return correct data. The enabled definition **"Ticket workflow" (id 1)** has `currentVersion: null` and therefore runs the built-in `defaultDefinition` (V1 linear). Ticket-triggered runs on the default pipeline do NOT need a definition write, so Tier 0 smoke can run once the browser is connected, even before the P0 fix.
- Consequence: run-execution tests split into **default-pipeline** (unblocked by P0, needs browser) and **custom-definition** (branch/loop/HITL/approval/params, blocked by P0 until fixed).

---

## 1. 🐞 P0: neon-http driver has no transaction support

**Symptom.** `POST /api/v1/workflow-definitions` → 500. Runtime log:
```
H3Error: No transactions support in neon-http driver
  at NeonHttpSession.transaction (drizzle-orm/neon-http/session.js)
  at createWorkflowDefinition (workflow-definition/store.ts:237)
  at POST /api/v1/workflow-definitions
```

**Root cause.** `apps/worker/src/db/client.ts` builds the DB with the HTTP driver:
```
drizzle({ client: neon(env.DATABASE_URL), schema })   // drizzle-orm/neon-http
```
neon-http is fetch-based and cannot run interactive `db.transaction(async tx => …)`. The definition store wraps every write in a transaction (plus a Postgres advisory lock and read-then-write logic):
- `createWorkflowDefinition` (store.ts:237) — POST create/duplicate
- `saveWorkflowDefinitionVersion` (store.ts:288) — PUT save graph version
- `updateWorkflowDefinition` (store.ts:340) — PATCH rename/enable
- `archiveWorkflowDefinition` (store.ts:391) — DELETE archive

All four therefore 500 on the deployed worker. Confirmed live: create 500.

**Why tests pass.** `client.ts` comment: the client supports "the neon-http production driver and the pglite test driver." Tests use pglite, which supports transactions; production uses neon-http, which does not. Classic test/prod driver divergence, so the 1206 green tests do not cover this path.

**Blast radius.** Every `db.transaction(...)` write path is broken on neon-http, not just definitions:
- `workflow-definition/store.ts` — create/save/enable/archive (definition management + editor).
- `approvals/store.ts:70` — approval writes, so the **send_plan_approval block and the Approvals approve/reject actions also 500** (Tier 3 plan-approval flow is broken on deploy).
- `lib/auth/invites.ts`, `lib/auth/invite-acceptance.ts` — dashboard invite create/accept.

The entire workflow-definition management surface (editor create/save/enable/delete, versioning, restore, duplicate) is non-functional on any neon-http deployment, including production if it uses the same driver.

**Not affected:** the run execution path. A repo-wide scan shows the agent workflow, run registry, reconciler, block-status/cost telemetry, and Slack/Jira/PR side effects use **no** `db.transaction`, so ticket-triggered runs on the pre-seeded default definition work on neon-http. A single driver fix (option 1) repairs definitions + approvals + invites at once.

**Fix options** (researched against the neon driver docs — the tradeoffs are real, this is a decision, not a drop-in):

1. **Switch to neon-serverless (WebSocket Pool).** Preserves the advisory-lock + atomic multi-write design and fixes definitions + approvals + invites at once. BUT the neon docs are explicit: the WebSocket `Pool` must be **created and ended per request** (`ctx.waitUntil(pool.end())`) and needs `neonConfig.webSocketConstructor = ws` (a new `ws` dependency) on Node. That conflicts with the current deliberate **module-singleton** `getDb()` (neon-http is fetch-based, no sockets, singleton-safe). So this is not a 5-line swap — it is a DB-lifecycle refactor touching every `getDb()` consumer, plus bundling `ws` into the Nitro build. Highest correctness, largest change/risk; the pglite test suite won't exercise it, so it needs live validation.
2. **Remove transactions from the transaction-using functions** (definitions + approvals). Rewrite as sequential neon-http statements with careful ordering (insert seed version before flipping the pointer, etc.). Keeps the singleton neon-http architecture; localized to `store.ts` + `approvals/store.ts`. Tradeoff: loses atomicity and the `pg_advisory_lock` serialization, so two concurrent edits could both compute the same next version or leave a definition without its seed row. Acceptable for a low-concurrency admin surface, a real safety regression for production.
3. **`db.batch()`** (neon-http atomic batch) — does not fit: the functions need read-then-write (select max(version) → insert version+1) and an advisory lock, which a static batch can't express.

**Researched decision (chosen).** Option 1 (Pool) is ruled OUT by a hard architecture constraint: `getDb()` is deliberately the fetch-based neon-http client because it must run inside **Workflow DevKit step bundles** — and `createApprovalRequest` (the `send_plan_approval` block) plus the whole run path execute in those bundles, where a WebSocket Pool cannot run. So the singleton must stay neon-http.

The clean fix, per the neon/drizzle docs, keeps the single neon-http driver and replaces interactive `db.transaction(async tx => …)` with atomicity that neon-http supports:
- **Single-statement atomic writes** via `db.execute(sql\`…\`)`, using CTEs where two writes must be atomic (e.g. `createApprovalRequest` = `WITH s AS (UPDATE … supersede) INSERT … RETURNING`; `createWorkflowDefinition` = `WITH d AS (INSERT definition RETURNING) INSERT version SELECT … FROM d`).
- **Compute-in-SQL** for read-then-write (version increment) = `INSERT … version = (SELECT COALESCE(MAX(version),0)+1 …)`, a single atomic statement.
- **Existing constraints as the real guarantee**: composite PK `(definition_id, version)`, the active-name partial unique index, and the one-pending-per-ticket partial unique index. Wrap the rare race in the existing `retryOnUniqueViolation` helper.
- **Drop the `pg_advisory_lock`** — the constraints, not the lock, are the correctness guarantee; the lock was belt-and-suspenders and is incompatible with per-statement neon-http.

This is driver-agnostic (works on both neon-http prod and pglite tests), needs no new dependency (no `ws`, no Pool), honours the fetch-only / WDK-safe design, and preserves atomicity where it matters. Apply on this feature branch, run the full suite + a live create/save/enable/archive/approval smoke on preview. Do not touch main.

**Status: implemented on the branch.** `workflow-definition/store.ts` (create/save/enable/archive) and `approvals/store.ts` (createApprovalRequest) no longer call `db.transaction`; version numbering is retry-guarded on the `(definition_id, version)` PK, create compensates by deleting an orphan definition if the seed-version insert fails, and the advisory lock is gone. Typecheck clean; the 172 workflow-definition + approvals tests and the full suite pass on pglite. Accepted tradeoffs (documented, admin-surface only): a tiny TOCTOU window on concurrent *enable* of overlapping-trigger definitions and on concurrent *archive-the-last*, which the dropped advisory lock used to close — negligible for a single-admin panel. **Deferred:** `lib/auth/invites.ts` + `invite-acceptance.ts` still use `db.transaction` (same bug, but the dashboard-invite flow is outside the workflow-testing scope); fix them the same way before relying on invites in a neon-http deploy. Next: redeploy the worker to preview and run the live write smoke.

---

## 1b. 🐞 P0 (safety): runs clone/PR EVERY repo the GitHub App can access, not one fixed repo

**Symptom (live).** A Tier-0 smoke ticket (AWT-1008) dispatched a run that, in `prepare_workspace`, cloned **four real Blazity repos** into the sandbox: `Blazity/ai-workflow`, `Blazity/agra-thumbnail-generator`, `Blazity/pre-sales-agent`, `Blazity/ai-workflow-arthur` — none of them a throwaway. The run was aborted (ticket moved out of AI → run `blocked`, `prUrl` null) **before** implementation/PR, so nothing was written. Left to finish it would have opened a PR on one of those real repos.

**Root cause.** Repo selection is driven by the **GitHub App installation scope**, not by `GITHUB_REPO`:
- `adapters/vcs/repository-directory.ts:49` calls `octokit.apps.listReposAccessibleToInstallation` — every repo the App (id `3632887`) can access becomes a candidate.
- `pre-sandbox/steps/repo-selection.ts` feeds those candidates to an LLM that picks which repo(s) the ticket touches (`prepare-workspace.ts:186-216`); if none match it asks "Which repository should this ticket modify?".
- `GITHUB_OWNER`/`GITHUB_REPO` (=`blazity/ai-workflow-demo`) are only the **legacy single-repo fallback** (`env.ts:187,322` `legacyRepoPath`) and do NOT constrain the modern multi-repo path.

**Required fix (config, not code).** Restrict the GitHub App (id `3632887`) installation on the Blazity org to **exactly one throwaway Test repo** (GitHub → Org settings → GitHub Apps → Configure → Repository access → *Only select repositories* → the Test repo). Then `listReposAccessibleToInstallation` returns just that repo and every run clones/PRs only it. Until this is done, **no run may reach an agent/workspace block** — even planning/cloning enumerates and reads real repos. This is the user's GitHub-admin action; the exact Test repo is theirs to name.

**Worse than clone-only — every run writes a remote branch to every accessible repo.** `prepare_workspace` runs `prepareSelectedRepositoryBranches` → `github.ts createBranch` → `octokit.git.createRef` (a REMOTE ref) on each selected repo, in the pre-sandbox phase, before any agent/implementation. AWT-1008 (aborted at planning) still left empty `blazebot/awt-1008` branches on **all 5 repos** (`ai-workflow`, `agra-thumbnail-generator`, `pre-sales-agent`, `ai-workflow-arthur`, `ai-workflow-demo`) — empty (default-HEAD, no commits, no PR) but real artifacts on real repos. Cleanup needs an account with push access (the `sercamembert` gh login has push=false on all of them), e.g. `for r in ai-workflow agra-thumbnail-generator pre-sales-agent ai-workflow-arthur ai-workflow-demo; do gh api -X DELETE repos/Blazity/$r/git/refs/heads/blazebot/awt-1008; done`.

**No repo-free run path exists.** `definition-step.ts:31 normalizeDefinitionForExecution` splices a virtual `prepare_workspace` between every trigger and its successor for any definition lacking one, so EVERY ticket run enumerates + branches the App's repos. There is no way to author a "safe" custom definition that skips repos. Therefore **all run-execution testing is hard-blocked until the GitHub App is scoped to `ai-workflow-demo` only.** A code-level allowlist (reject any repoPath not in an env allowlist, inside `createRepositoryDirectory`/`prepareSelectedRepositoryBranches`) is recommended as defense-in-depth so the app refuses off-list repos regardless of App scope.

**Also found:** `call_llm` uses `lib/llm.ts` which hardcodes `@ai-sdk/anthropic` `anthropic(model)` — it ignores the block's provider and can only ever call Anthropic, so on a codex-only / invalid-Anthropic deployment `call_llm` always fails (design limitation, not just an env gap).

**Validated en route:** T7.3 live — moving a ticket out of the AI column cancels its ticket-kind run (`status: blocked`, no PR). ✅

## 2. Block registry (28 blocks)

From `@shared/contracts` `BLOCK_TYPE_SPECS` + `BLOCK_PARAM_KEYS` and `schema.ts` params.

| Block | Category | Ports (+failure) | Params |
|---|---|---|---|
| trigger_ticket_ai | trigger | out | — |
| trigger_plan_approved | trigger | out | source |
| trigger_pr_created | trigger | out | providers, onlyWorkflowOwned |
| trigger_pr_checks_failed | trigger | out | providers |
| trigger_pr_review | trigger | out | providers, on |
| planning_agent | action | out +failed | provider, model |
| implementation_agent | action | out +failed | provider, model |
| review_agent | action | out +failed | provider, model |
| fix_agent | action | out +failed | provider, model, instructions, maxMinutes |
| generic_agent | action | out +failed | provider, model, prompt, outputSchema |
| prepare_workspace | action | out +failed | — |
| finalize_workspace | action | out +failed | requiredChecks |
| run_pre_pr_checks | action | out +failed | maxFixCycles (0-5) |
| run_checks | action | out +failed | commands |
| call_llm | action | out +failed | prompt, system, model, outputSchema |
| fetch_pr_context | action | out +failed | — |
| open_pr | action | out +failed | — |
| update_ticket_status | action | out +failed | target |
| post_ticket_comment | action | out +failed | body |
| post_pr_comment | action | out +failed | body, target |
| send_slack_message | action | out +failed | message |
| send_plan_approval | action | (terminal, no ports) | planFromStep, mirrorComment |
| human_question | action | out +failed | questions |
| arthur_injection_check | action | out +failed | contentFromStep |
| arthur_trace | action | out +failed | taskName |
| branch | control | true / false | condition |
| loop | control | continue / exhausted | maxAttempts (1-20), onExhaust (fail/human/continue) |
| terminate | control | (terminal, no ports) | terminalStatus, postComment |

---

## 3. Blocks possibly unnecessary (analysis, to confirm with product intent)

Not defects; candidates to drop for a leaner tool depending on which flows are in scope.

- **arthur_injection_check, arthur_trace** — Arthur-specific security tracing. Dead weight unless Arthur is actually wired for the demo/customer. Strongest removal candidates if Arthur is out of scope.
- **The 3 PR triggers + fetch_pr_context** — only used by PR-driven flows (auto-fix on failed checks / review). If the product is ticket→PR only, these five (`trigger_pr_created/checks_failed/review`, `fetch_pr_context`, arguably `post_pr_comment`) are optional.
- **run_checks vs run_pre_pr_checks** — overlap. `run_pre_pr_checks` runs checks + agent fix-cycles; `run_checks` is report-only. Could consolidate to one block with a "fix cycles" param.
- **send_slack_message** — the runtime already auto-sends Slack notifications (`notifyTicket`: started/needs_clarification/pr_ready/failed/…). The explicit block only adds custom ad-hoc messages; redundant if custom copy isn't needed.
- **human_question** — overlaps the implicit clarification path (agents already return `needs_human_input` and park the ticket). Keep only if an explicit, non-agent gate is wanted.
- **call_llm vs generic_agent** — both run an LLM step; `call_llm` is a lightweight no-workspace prompt, `generic_agent` is a full agent with workspace + output schema. Defensible to keep both, but note the overlap for simple "ask the model" steps.

Everything else (5 agents, prepare/finalize_workspace, open_pr, update_ticket_status, post_ticket_comment, branch, loop, terminate, the 3 core triggers, send_plan_approval) maps to a distinct, non-redundant responsibility.

---

## 4. Graph validator edge-case catalog (`schema.ts`)

Two layers gate `PUT /workflow-definitions/{id}`: the zod schema (`Invalid definition: …`) then `validateWorkflowGraph` (`Invalid workflow: …`). Full case list (⛔ e2e-blocked by P0 §1 — the PUT itself 500s; documented from source, to be re-run after the fix):

**Zod schema (400 "Invalid definition"):**
- schemaVersion ≠ 1.
- unknown node `type` (discriminated union).
- extra/unknown param key (`.strict()` on every params object).
- missing required param (e.g. branch without `condition`, loop without `maxAttempts`/`onExhaust`, terminate without `terminalStatus`).
- `model` not matching `^[A-Za-z0-9._:\/-]+$` or >200 chars.
- `provider` not in {claude, codex}.
- edge with extra key / missing from|to (`.strict()`).

**Graph validation (400 "Invalid workflow"):**
- duplicate block id → `Block id "X" is used more than once.`
- zero triggers → `Workflow must contain at least one trigger block.`
- >1 trigger of one type → `Workflow contains more than one <type> trigger block.`
- edge to/from unknown block → `Connection references an unknown source/target block "X".`
- self-edge → `Block "X" cannot connect to itself.`
- outgoing edge from terminal block (terminate, send_plan_approval) → `Terminal block "X" (<type>) cannot have outgoing connections.`
- edge using a port the block doesn't have → `Connection from "X" uses unknown port "P" …`
- branch/loop edge without `fromPort` → `Connection from branch/loop "X" must specify a port (…).`
- duplicate identical edge → `Duplicate connection from "X" to "Y".`
- two edges from the same port → `Block "X" has multiple connections from port "P".`
- trigger with an incoming edge → `The trigger block "X" must not have incoming connections.`
- non-trigger block unreachable → `Block "X" is not reachable from a trigger.`
- branch missing true/false → `Branch "X" must have its "true"/"false" port connected.`
- loop missing continue → `Loop "X" must have its "continue" port connected.`
- loop onExhaust "continue" without exhausted wired → `Loop "X" with onExhaust "continue" must have its "exhausted" port connected.`
- loop continue port not looping back → `Loop "X"'s continue port must lead back to it.`
- cycle not through a loop → `Blocks "a" -> "b" -> "a" form a cycle that does not pass through a Loop block.`
- cycle region with ≥2 loops → `… cycle region with N Loop blocks; each cycle region must contain exactly one.`
- branch condition unparseable → `Branch "X" has an invalid condition: <error>.`
- branch condition references a non-ancestor/unknown step → `Branch "X" condition references block "Y" which does not run before it.`

A battery (`scratchpad/api_battery.py`, 20+ cases + CRUD conflict cases) ran live against the deployed worker after the §1 fix: every malformed graph is rejected 400 with the exact message above; every CRUD conflict returns the right 409.

---

## 4b. Tier 0 smoke PASSED live on `blazity/ai-workflow-demo` (with the allowlist)

After deploying `AGENT_ALLOWED_REPOS=Blazity/ai-workflow-demo` + the §1b guard, re-running AWT-1008:
- ✅ `prepare_workspace` selected **only** `github:Blazity/ai-workflow-demo` (the 4 real repos were filtered out) — allowlist verified live, even though the ticket named no repo.
- ✅ Full default pipeline succeeded: `planning → implementation → review → checks → open-pr → slack → status`, all blocks `ok`.
- ✅ Telemetry: `status=success`, `model=gpt-5.4-mini` (codex), **`cost=$0.3472`** (cost tracking works), no error.
- ✅ PR **#291 on `Blazity/ai-workflow-demo`** — verified diff: the required one-line README append, clean.
- ⚠️ Finding: the implementation agent also committed a `blazebot/memory/AWT-1008.md` session-memory file, despite the ticket saying "change only README.md". It is bot bookkeeping (harmless) but it does violate an explicit single-file instruction.
- ⚠️ Workflow limitation: the local gh account is read-only on these repos, so the orchestrator can VERIFY PRs but cannot close them or delete branches. Closing PR #291 + deleting the leftover `blazebot/awt-1008` branches (on the 4 real repos from the first aborted run, and on ai-workflow-demo) needs a write-access account, or grant the test account write on `ai-workflow-demo` so the loop can self-clean.

## 4c. Tier 1 partial: call_llm on codex + a reconciler gotcha

Authored a custom definition via API (now that §1 is fixed): `trigger -> call_llm{provider:codex, model:gpt-5.4-mini} -> post_ticket_comment -> update_ticket_status{ai_review} -> terminate{done}`, enabled it (disabling the default), ran ticket AWT-1009:
- ✅ **`call_llm` succeeded on codex live** (`llm:ok`, model gpt-5.4-mini) — the provider-aware fix works end-to-end, not just in unit tests.
- ✅ Allowlist double-confirmed: `prepare` selected only `ai-workflow-demo`; a precise ref check shows `blazebot/awt-1009` exists ONLY on `ai-workflow-demo`, never on the 4 real repos.
- 🐞 **Gotcha:** the run ended `blocked`, not `success`. `update_ticket_status{ai_review}` moved the ticket OUT of the AI column, and the reconciler's "ticket left AI -> cancel ticket-kind run" logic then blocked the run (before `terminate`). So a definition that moves the ticket out of AI via `update_ticket_status` can cancel its own run depending on timing. The default pipeline also ends with a status move yet AWT-1008 reported `success` and stayed visually in the AI column — the success-vs-blocked outcome looks timing-dependent and needs a deterministic fix (e.g. suppress the leave-AI cancel while a run for that ticket is still finalizing, or treat a workflow-driven status move differently from a human one). Follow-up.

## 4d. Cleanup owed (needs a write-access account; orchestrator gh login is read-only)

- **PR #291** on `Blazity/ai-workflow-demo` (from AWT-1008): verify + **close** (do not merge), delete its branch.
- Delete `blazebot/awt-1008` on the **4 real repos** (empty, from the first pre-allowlist aborted run): `ai-workflow`, `agra-thumbnail-generator`, `pre-sales-agent`, `ai-workflow-arthur`.
- Delete `blazebot/awt-1008`, `blazebot/awt-1009`, `blazebot/awt-1010` on `ai-workflow-demo`.
- Delete `blazebot/awt-1011` on `ai-workflow-demo` (from the stress run).
- One-liner (run as a write-access account): `for r in ai-workflow agra-thumbnail-generator pre-sales-agent ai-workflow-arthur ai-workflow-demo; do for b in awt-1008 awt-1009 awt-1010 awt-1011; do gh api -X DELETE repos/Blazity/$r/git/refs/heads/blazebot/$b; done; done` and `gh pr close 291 --repo Blazity/ai-workflow-demo`.

## 4h. Live stress run: generic_agent + run_checks + branch (headline control flow)

Authored a stress definition (`trigger -> prepare -> generic_agent -> run_checks -> branch(steps.generic.output.status == 'ok') -> [true] post_ticket_comment -> terminate(done)`), ran AWT-1011:
- ✅ **generic_agent** ok on codex (produced JSON), **run_checks** ok (ran `ls`/`echo`, report-only), **branch** ok with `path=true` (evaluated the condition on the real agent output and took the true port). Three blocks not previously exercised live, plus the headline control-flow branch, all green in one run; run `success` (ended on `terminate`, so no reconciler status-move gotcha). Allowlist held (only `ai-workflow-demo`).

### Live-exercised blocks so far (15 of 28)
prepare_workspace, planning_agent, implementation_agent, review_agent, run_pre_pr_checks, open_pr, send_slack_message, update_ticket_status (Tier 0); call_llm, post_ticket_comment, terminate (def run); planning->needs_human_input clarification park (HITL); trigger_ticket_ai; generic_agent, run_checks, branch (stress). NOT yet live (deterministically covered): loop, human_question, finalize_workspace, fix_agent, post_pr_comment, fetch_pr_context, send_plan_approval, trigger_plan_approved, the 3 PR triggers, arthur_injection_check, arthur_trace — these need a real PR webhook (PR flow), a configured Arthur, or a plan-producing agent (approval), so they stay deterministic-only until that integration is wired. Full per-block matrix: `docs/testing/block-reference.md`.

## 4g. Live HITL clarification confirmed; plan-approval flow gated by planning agent

Authored a V3 approval definition via API (chain 1: trigger_ticket_ai -> prepare -> planning -> send_plan_approval; chain 2: trigger_plan_approved -> post_ticket_comment -> terminate), enabled it, ran ticket AWT-1010:
- ✅ **HITL clarification live**: the planning agent returned `needs_human_input`, the run took the clarification exit (block `warn`, run `success`), and the ticket was parked to backlog with a `needs-clarification` label. Confirms the end-and-re-enter HITL path with the real agent.
- ⚠️ The plan-approval WRITE path (`createApprovalRequest`, one of the P0-transaction-fixed writers) was NOT reached live because `send_plan_approval` only runs after a plan is produced, and this demo's planning agent tends to ask for clarification on any not-fully-specified ticket (also visible on AWT-867). So the approval mechanism is validated at the unit level (approvals store tests in the 1435 suite) and via the identical transaction-removal pattern proven live on definition writes (create/save/enable 500 -> 200), but a full send_plan_approval -> approve -> chain-2 dispatch was not demonstrated live. To show it live, feed a fully-specified ticket the planning agent will not clarify.

## 4e. Engine regression test suite (214 new deterministic tests)

Rather than only clicking Jira tickets, the engine now has a real, repeatable, CI-ready regression suite (runs inside `pnpm test`, pglite, no GitHub/Jira/LLM). `executeGraph` is a pure function with an injectable `executeBlock` (fake block outputs) and `hooks` (spy on all side effects/persistence), so the whole engine is testable deterministically. 214 tests added across 7 new files, full suite now **1426/1426 green**, ~44s:
- `interpreter.edge.test.ts` (26): execution cap (exact N vs N+1), branch (missing/earlier-output/unwired port), loop (NaN/0 maxAttempts, unknown onExhaust, exhausted->branch, continue-not-looping-back), terminate, action ports (unwirable/portless -> engine fail), 500-char truncation, hook ordering + attempt matching, buildRuntimeGraph.
- `schema.edge.test.ts` (21): every validator rejection message + all V1-V4 fixtures validate clean.
- `conditions.edge.test.ts` (47): parse/eval precedence, parens, negation, nested paths, strict eq/neq, missing refs, malformed input.
- `golden-runs.edge.test.ts` (22): each fixture definition (V1-V4) driven end-to-end through executeGraph on each meaningful path — the engine-level e2e anchors.
- `agent-llm.edge.test.ts` (33): call_llm provider routing (codex vs claude), generic_agent schema, resolve-agent precedence.
- `io-blocks.edge.test.ts` (40): repo allowlist (filter + throw), post/comment/status/checks/finalize blocks.
- `loader-triggers.edge.test.ts` (25): virtual-prepare injection, definition resolution, dispatch/gate/coalesce.

**Testability findings (worth a small refactor to make them testable + cleaner):**
1. `interpreter.ts:146-153` branch eval-error catch is effectively dead: `evaluateCondition` is a fully-guarded pure switch that never throws for a parseable condition. Either drop the catch or document it as defensive.
2. resolve-agent full precedence (`agent.ts:709-712`, `runDefaultKind = parseAgentKindOverride(labels) ?? env.AGENT_KIND`) is inline and not unit-testable; extract a pure helper.
3. `update_ticket_status` target mapping is inline in the `agent.ts` executeBlock switch (`agent.ts:1165-1170`, closure-local `aiReviewMoveTarget()`/`backlogMoveTarget()`); extract a pure mapping helper so the ai_review/backlog/default routing can be unit-tested.

## 4f. Testability refactor + telemetry integration test (agent-built, adversarially verified)

- Extracted two pure helpers so previously-inline logic is unit-testable + cleaner: `resolveRunDefaultKind(labelOverride, envAgentKind)` (resolve-agent.ts) and `resolveTicketMoveTarget(target)` (new ticket-move-target.ts); agent.ts calls them. Documented the defensive branch-eval catch in interpreter.ts. Behavior-preserving (3 adversarial verifiers confirmed), +5 tests.
- Added `run-telemetry-integration.test.ts` (4 tests): drives the REAL interpreter (buildRuntimeGraph/executeGraph) + REAL telemetry writers (recordBlockStatuses/recordRunUsage) against a REAL pglite DB, asserting persisted block_statuses jsonb + workflow_runs fields (status/model/costUsd/costKnown/tokens/phases/pr) for happy, needs_human_input, and failed (with/without failure edge) runs. A verifier mutation-tested it (breaking the writer's ON CONFLICT made all 4 fail) so it genuinely bites. Known limit: a full `agentWorkflow` run (Target A) is infeasible to fake (WDK use-workflow + real sandbox/Jira/GitHub), so the harness reconstructs agent.ts's orchestration around the real writers rather than importing it; it locks the writers + interpreter, not agent.ts's own use of them. Follow-up: extract agent.ts's hook-wiring into a shared helper so the integration test can import the real thing.

Suite now **1435/1435 green**, deterministic, CI-ready.

## 5. Verified so far (live, on preview)

- ✅ Auth: sign-in 200 from the preview origin (multi-origin fix holds).
- ✅ Reads: `GET /workflow-definitions`, `/workflow-definitions/{id}`, `/runs/live` — 200, correct shapes.
- ✅ Enabled definition id 1 runs the built-in default V1 linear graph (currentVersion null).
- ✅ **Definition management (Tier 6):** create, duplicate, save-version, rename, enable, archive, version history, restore — all 200 after the §1 fix; enable-conflict / rename-collision / archive-enabled / archive-last all 409.
- ✅ **Graph validator (Tier 7 save-validation):** zod rejections (schemaVersion, unknown type, strict extra param, bad model regex) and graph rejections (no/duplicate trigger, trigger-incoming, branch/loop port wiring, cycle-without-loop, non-ancestor condition, terminal-with-outgoing, duplicate id) all 400 with exact messages.
- ✅ §1 P0 fix confirmed live (create was 500 → now 200); full worker suite 1206/1206 on pglite.

---

## 6. Blockers and next steps

1. ✅ **P0 §1 fixed** — per-statement writes, deployed to preview, validated live.
2. ⛔ **Connect the Claude-in-Chrome extension** (user) → the only thing blocking the run-execution tiers (Tier 0-5: agents run, PRs on `blazity/ai-workflow-demo`, cost/telemetry, HITL, plan-approval, PR triggers). Real runs need real AWT tickets, created via Chrome per the goal.
3. Once connected, run the tiers from `e2e-workflow-test-plan.md` (cheap models; env-pinned to `blazity/ai-workflow-demo`). Custom definitions (branch/loop/HITL/approval) can now be authored via API since §1 is fixed.
4. Optional hardening: apply the same de-transaction fix to `lib/auth/invites.ts` + `invite-acceptance.ts` before relying on invites on a neon-http deploy.

---

## 7. Full live block coverage (2026-07-14) — 28/28 exercised

Every one of the 28 workflow block types has now been triggered on a real run on the
`ai-workflow-demo` preview, verified via `GET /runs/block-statuses` (pending → running → ok)
and each run's `__prepare.repositories == [github:Blazity/ai-workflow-demo]` (allowlist held).
All runs used codex `gpt-5.4-mini` and stayed on the demo repo only.

Representative run evidence (definition id → run):
- Default pipeline + agents (Tier 0, 9 blocks): prior AWT-1008..1012 runs.
- `loop`: def 10, run `…XABZHCV9` (AWT-1014) — `retry` block iterated maxAttempts:2 (`run_checks` ran twice, attempt counter 1→2), then took the `exhausted` edge → comment → terminate.
- `send_plan_approval` + `trigger_plan_approved`: def 11 — chain1 run `…23E3T3` parked with `awaiting_approval` + wrote an `approval_requests` row; `POST /approvals/{id}/approve` dispatched chain2 run `…0PCSXC` (comment + terminate).
- `implementation_agent` → `finalize_workspace`: def 13, run `…1R11SG` (AWT-1017) — opened bot PR #292.
- `trigger_pr_created` + `fetch_pr_context` + `post_pr_comment`: def 12, run `…38JYEQ` (`source: live`, pr_trigger) — fired on PR #292 reopen, commented on the PR.
- `trigger_pr_checks_failed`: def 14, run `…F9J0GZ` (AWT-1018, PR #293) — fired by a synthetic failing check_run.
- `trigger_pr_review`: def 15, run `…XVHB9M` (AWT-1019, PR #294) — fired by a human "request changes" review.
- `fix_agent`: block executed `ok` ("implemented") in a ticket flow (def 13 v2); its downstream `finalize_workspace` needs a real committed diff (see finding 7c).

### 7a. BUG (fixed + deployed): case-sensitive webhook repo guard

`routes/webhooks/github.post.ts` compared `${repo.owner.login}/${repo.name}` against
`${GITHUB_OWNER}/${GITHUB_REPO}` with `!==`. GitHub delivers `owner.login` as `Blazity`
(capital) while the demo env sets `GITHUB_OWNER=blazity` (lowercase), so **every** github
webhook for the demo repo was dropped as `other_repo` — silently disabling all three PR
triggers (`trigger_pr_created`, `trigger_pr_checks_failed`, `trigger_pr_review`) and the
post-PR gate. GitHub owner/repo slugs are case-insensitive. Fixed to compare
`.toLowerCase()` both sides (+ regression test in `github.post.test.ts`), commit `f4bc39a`,
deployed to the demo. Verified live: the same reopen event that returned `other_repo` before
the deploy dispatched a run after it.

### 7b. FINDING (open): only the first PR trigger per ticket dispatches; the rest coalesce

A ticket's **first** PR-trigger run dispatches, but a **second** PR-trigger for the same
ticket (same `blazebot/awt-<n>` branch) returns `{"status":"ignored","reason":"coalesced"}`
even with an empty `active_runs` registry. Root cause is the `verify_claim_after_start` path
in `claimTicketRun` (`lib/dispatch.ts`): after `start()` the re-read `getRunId(ticketKey)`
no longer equals the claim sentinel, so the run is aborted as `already_claimed`. Reproduced
6× on AWT-1017 after its `trigger_pr_created` run; avoided by testing each PR trigger on a
**fresh** ticket/PR so it is that ticket's first PR trigger. Worth hardening (a PR can
legitimately get a checks-failed and a review over its lifetime).

### 7c. Note: `fix_agent` + `finalize_workspace` in a ticket flow

In a ticket-triggered flow, `fix_agent` created the requested file but did not `git commit`
(agents don't always commit; the commit-guard Stop hook did not force it), so
`finalize_workspace` failed with "Agent reported success but made no commits" (`preAgentSha`
unchanged → nothing to push). `implementation_agent` commits reliably, so
`implementation_agent → finalize_workspace` publishes a PR cleanly (def 13, PR #292).
`fix_agent`'s designed home is the PR-fix flow where `fetch_pr_context` supplies a real diff
to act on.

### 7d. Config note: `VCS_BOT_LOGIN` is set on the demo

The bot's own reviews are correctly filtered (`trigger_pr_review` ignored a
`blazity-ai-workflow[bot]` review as `event_pull_request_review`); a human (non-bot) review
is required to fire the trigger — confirmed with an `outof-place` review on PR #294.

### 7e. GitHub App change (documented per team request)

Added **Check run** + **Pull request review** event subscriptions to the org App
`blazity-ai-workflow` (webhook → demo worker only; no permission change, repo access left at
`all`). Documented in `docs/GITHUB-APP-SETUP.md §5` (commit `81bede4`).
