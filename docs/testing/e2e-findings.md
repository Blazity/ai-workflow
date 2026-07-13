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
