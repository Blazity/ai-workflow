# Review ledger: production e2e test plan (2026-08-26, v2 after skeptic pre-mortem)

Feature under test: PR #345 (`feat/review-ledger`), flag `REVIEW_LEDGER_ENABLED` (env, default off).
V1 scope constraint: the ledger activates ONLY for runs whose entry trigger is `trigger_pr_review`. Ticket-graph runs and `trigger_pr_checks_failed` runs must be byte-for-byte unaffected.

Skeptic pre-mortem: 10 findings; 1, 2, 4, 5, 6, 7, 8 and the minors folded in below. Finding 9 (drop GitHub rounds) rejected: the operator explicitly requested GitHub coverage; it runs as its own gated exercise on the GitHub-only definition with manual dispatch, no webhook dependency. Finding 3 resolved by measurement (P0).

## Environment prerequisites (in this order)

| # | Prerequisite | Status / how verified |
|---|---|---|
| P0 | Operator identity differs from platform bot identity on both providers | DONE: GitLab bot is `project_84735538_bot_904507d72550db9a12f410d006daeeb2` (name "ai-workflow"), operator is `filipmaszota3`; GitHub bot is the prod GitHub App, operator is Filip's account |
| P1 | PR #345 merged to main, prod deploy green with flag OFF | `gh pr view`, deployment status, `/cron/poll` 200 |
| P2 | Definitions exist: def 33 "Review ledger e2e" (GitHub, `on: changes_requested`, `scope: any`, deployed v3, DISABLED, manual dispatch only) plus a GitLab twin (requires `GITLAB_BOT_LOGIN`, added to prod env 2026-08-26, effective from the next deploy; GitLab defs must include `on: commented`) | `workflows_list`; publish validation passes after the post-merge deploy |
| P3 | Flag-off regression probe THROUGH def 33: manual dispatch on a PR with a changes-requested review, flag off; expect legacy behavior (no thread replies, no markers, no resolves) | run trace + PR threads untouched |
| P4 | `REVIEW_LEDGER_ENABLED=true` set on prod worker env, redeploy, `/cron/poll` 200 | separate step AFTER P3 (deploy and flag are two steps) |
| P5 | Test repos (from prod `AGENT_ALLOWED_REPOS`): GitLab `filipmaszota3/ai-workflow-integration-test` (project 84735538), GitHub `Blazity/aiw-checks-fixture` | probe MR/PR per provider |
| P6 | Model matrix: core rounds on `builtin-claude`; one contrast round on the cheap profile (Haiku) with a falsifiable expectation (see round H) | definition harness profile in run trace |

Guard discovered during setup (run wrun_01M0Z1FJ68GCY0GPR3CEP0XKKS): the platform refuses `trigger_pr_review` graphs with `scope: any` that reach mutating blocks ("workflow is not review-safe"), an injection defense. Both e2e definitions therefore use `scope: workflow_owned`, and every target MR/PR must be CREATED BY A WORKFLOW RUN. The hand-made fixtures (GitLab MR !12, GitHub PR #11) are superseded as dispatch targets; fresh workflow-owned MRs come from def 14 ticket runs (which also satisfies the "bigger tickets" requirement). Review threads are then planted against the run-generated diff.

Operational rules learned in pre-mortem:
- Definitions stay DISABLED for all rounds; every run starts via `workflows_dispatch` (no webhook storms, no run-budget burn). The webhook path gets one controlled window in round W.
- Preflight requires the PR to actually carry a matching review state; each round posts the review first, then dispatches.
- One MR per round group; def 29 interference test (E2) uses a separate MR; destructive E1 runs last on its group.
- Review threads MUST be diff discussions (`POST /merge_requests/:iid/discussions` with a full `position` payload); assert `resolvable: true` before dispatch; refresh `head_sha` after every pushed fix.
- The `already_addressed` plant must point at content in the SAME file within 40 lines of the thread anchor (evidence window is deterministic).
- Runs on one PR share a claim; space dispatches so the previous run reaches terminal first (a CONFLICT here is claim hold, not a bug).

## Core rounds

MR-1 (fresh GitLab MR, planted defect) hosts rounds A-D; GitHub group repeats A and B on a fresh PR in `aiw-checks-fixture` via def 33.

### Round A: actionable + already_addressed
Post one changes-requested review with two diff discussions: T1 asks for a real change (actionable); T2 asks for something the branch already contains, planted same-file within 40 lines. Dispatch.

Expected: gate `proceed`; exactly one fix commit; T1 reply `Addressed in <sha>` (sha = pushed head) and thread RESOLVED; T2 reply with file quote + location, thread OPEN; both replies carry the ledger marker AND the bot marker; run success; trace shows the `reviewLedger` projection.

### Round B: question + out_of_scope
Two new diff discussions: T3 question, T4 out of scope. Dispatch.

Expected: both replied, both OPEN, no commit, clean `no_change` terminal (green), PR comment variant "Replied to review threads; no code changes were needed."

### Round C: re-dispatch with nothing new
Dispatch again, zero new human comments. All threads are parked (last note is a ledger reply).

Desired outcome (asserted by branch unit tests, verified here on prod): zero work items, clean `no_change`, ZERO new MR notes, no resolution state changes. Known alternative endings if this fails: legacy no-change gate red on "PR has feedback", or publish guard "no work items + no changes". Either alternative is a FINDING, not a pass.

### Round D: human replies into an answered thread
Operator writes a follow-up note inside T2. Dispatch.

Expected: T2 returns as a work item (stale marker); `review_ledger.reopened` metric emitted; new disposition and reply posted.

### Round E: forced failure with open threads
On MR-1 after D, or a fresh thread T5: force a post-feed failure (unsatisfiable check).

Expected: ONE failure note for THIS run naming unsettled aliases (or the "answered all N, then failed" variant); note carries `ledger-failure:<runId>`. Idempotency contract is PER RUN: a replay of the same run must not duplicate the note, but a second failed run legitimately posts a second note (N failed runs = N notes).

## Edge cases

| # | Edge | Expected |
|---|---|---|
| E1 | Silent reopen (LAST on its MR): unresolve T1 without commenting, dispatch | thread returns as work item; expected terminal stated up front: re-fix (proceed) or `already_addressed`-style answer; a publish-guard FAILED on "actionable + no changes" is a finding |
| E2 | `trigger_pr_checks_failed` run (def 29) on a SEPARATE MR with open threads | no ledger effects: no replies, no resolves, no thread-naming failure note |
| E3 | Third-party bot thread on the MR | context bucket only; never disposed, never replied |
| E4 | Cap: >20 open work-item threads (scripted) | feed caps at 20, `truncated` reported, remainder next run |
| E6 | Evidence rejection, deterministic variant: plant a T-item whose true answer lives in ANOTHER file (outside the window) | verifier rejects, one corrective retry, then loud fail listing the thread; unit-covered, e2e best effort |
| W | Webhook window (GitLab def enabled briefly): positive control = operator posts a review note, expect a run to start; negative = settle replies from the bot start NOTHING; assert raw note bodies contain the bot marker | delivery log: exactly the human-triggered run; then disable the def |

## Status and UI checks (dashboard, screenshots)

1. Run list: success / no_change / failed statuses per round.
2. Run trace: dispositions in agent output; `settled[]` in finalize output; failure reason naming threads in round E.
3. Claims: `active_runs` released after each terminal (check AFTER the reconcile window, cron 15 min, not seconds after the run).
4. Screenshots: MR/PR thread states per round, dashboard trace, run list.

## Round H (model contrast, falsifiable)
Repeat round B's shape on the cheap profile. PASS = no silent green: either clean `no_change` with all threads answered, or retry → fail naming threads. FAIL = green run with any work-item thread left unanswered.

## Deliverable
English QA report in `docs/qa/` with: environment, per-round evidence (run ids, links, screenshots), edge matrix PASS/FAIL, known limitations, rollback note stating the true cost: set `REVIEW_LEDGER_ENABLED=false` PLUS a Vercel redeploy (env changes do not apply to running deployments).
