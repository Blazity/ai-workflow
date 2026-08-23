# Repository scripts: production QA (2026-08-23)

Scope: end-to-end verification of the repository scripts feature (PR #343, merged as `b3c48ed3`) on the production deployment (`ai-workflow-app` + `ai-workflow-app-dashboard`), driven through real Jira tickets on the AWP board. Every user story from `docs/plans/2026-08-21-repository-scripts.md` was exercised against `Blazity/aiw-checks-fixture` (a python `uv` + yarn repo shaped like a real client engine) and `Blazity/ai-workflow-prod`.

## Deployment under test

- Dashboard deployed before the worker (new-block-type skew rule), then worker `ai-workflow-1nfjfgyiv`. Smoke: `blocks_get run_scripts` over production MCP returns the full typed contract (outcome enum, per-group status enum, `statusVariants ["ok","skipped"]`).
- Worker production env: `PRE_PR_CHECKS_ALLOWED_ENV=AIW_FIXTURE_TOKEN` plus the `AIW_FIXTURE_TOKEN` value itself, both added before the worker deploy so the deployment carries them.
- Scripts config written through the production store path (schema parse + operator allowlist check + `savePrePrCheckConfig`), versions v8 through v14, actor label "Claude (repository scripts prod QA)".

## Test matrix and results

All runs used definition 30 (opus profile) unless stated; definition 32 "Repository scripts QA" is a purpose-built graph: `trigger -> prepare_workspace -> run_scripts -> branch(anyFailed) -> post_ticket_comment(body = steps.scripts.output.summary)`.

| Run | Ticket | Config | Expectation | Result |
|---|---|---|---|---|
| A happy path, long batch | AWP-110 | v8: gate `verify`+`envcheck`+`slow`+`dirty` | batch > 300 s completes; PR delivered | PASS. Checks node ran 647,515 ms (10.8 min) in one block, status ok; PR [#9](https://github.com/Blazity/aiw-checks-fixture/pull/9) contains only the ticket's file |
| B failing group | AWP-112 | v9: gate `lint`+`fail` | one legible Jira comment naming repo, command, exit code, tail | PASS. Comment carries "Repository scripts failed.", `exit 3`, output tail, diagnostic id, and the maxFixCycles note |
| C hanging command | AWP-113 | v10: gate `envcheck`+`hang`, `commandTimeoutMinutes: 2` | per-command timeout as a result, not a dead run | PASS. `exit 124`, "timed out after 2 minutes and was killed... neither a passing nor a failing check", names both remediation levers |
| D failing setup | AWP-114 | v11: setup ends `exit 7` | early loud could-not-start, distinct from failing checks | PASS. Run failed in 63 s at the prepare phase, before any agent ran: "Setup failed in 1 of 1 repositories... Fix the setup command in the repository scripts configuration." |
| E / E2 zero matching entries | AWP-115 / AWP-117 | v8 (repo w/o entry) / v13 (fixture w/o entry) | loud `skipped`, PR passes | PASS. Checks node completed with status `skipped`, finalize accepted it, PR [#10](https://github.com/Blazity/aiw-checks-fixture/pull/10) delivered. (AWP-115 itself ended blocked by a pre-existing platform guard, see notes) |
| F1 run_scripts green | AWP-111 | v8, def 32 v1 groups `envcheck`+`lint` | branch takes the false port, summary comment | PASS. "Repository scripts passed (5 commands)." = deps(1)+lint(2)+envcheck(2): extends expansion deduplicated |
| F2 run_scripts red | AWP-111 | v8, def 32 v2 groups `envcheck`+`fail` | branch takes the true port, failure summary | PASS. Comment names repo, command, `exit 3`, output tail |
| G batch budget spent | AWP-116 | v12: `batchTimeoutMinutes: 3`, gate `slow`+`lint` | partial results, unreached groups not run | PASS. "CHECK BATCH ABANDONED... 5 of 8 commands had finished. Nothing was verified: this is a timeout, not a passing or a failing check result." |

User stories 1 through 9 from the plan are all covered by the rows above: long batches (A), setup phase on a python repo in the node24 sandbox (A, F1), env names with the operator allowlist (A, F1 positive; the PUT-side rejection is covered by route tests), per-command results in Jira (B, C, F2, G), branching on typed outcomes (F1, F2), the three distinguishable failure classes (B vs D vs E2), timeout as a result (C), named groups run selectively from a block (F1, F2), and typed autocomplete-ready outputs (the deployed `bindingSchema` carries the enums; F1/F2 consumed them live).

## Behaviors confirmed in passing

- Mixed config shapes in one document: the `Blazity/ai-workflow` entry stayed verbatim legacy (`commands`) while the fixture used named groups; both parse and the legacy entry normalizes to `groups.checks` at read.
- `restoreTree`: the `dirty` group appended to a tracked file during run A's batch; the tree was restored and PR #9 contains only the ticket's change.
- Setup at workspace creation: run D failed at prepare, spending no agent tokens; run F1's workspace step (25.6 s) carried the uv install so the scripts step took 16.5 s.
- The `maxFixCycles` note: definitions that still carry the key get one honest sentence that the repair loop is gone; nothing crashes.
- A failing group does not fail the `run_scripts` block itself (`statusVariants ["ok","skipped"]`); failure travels through `outcome`/`anyFailed` and stays branchable.

## Notes and follow-ups

1. AWP-115 (run E) ended `blocked`: "Jira AI Review transition before durable PR publication evidence". The ticket was moved to review by a Jira/GitHub automation on branch push in `Blazity/ai-workflow-prod` before the PR existed; the platform's phantom-PR guard then refused. Not a repository-scripts defect (the fixture has no such automation; runs A and E2 delivered normally). Worth knowing for any tenant with issue-key automations on branch events.
2. Copy polish (minor): the failure comment renders the failing command twice, once in the failures section and once in the always-rendered engine summary (visible in runs B and C).
3. Vocabulary nuance (minor): a repo batch stopped by `batchTimeoutMinutes` reports as "Repository scripts could not be started" + "CHECK BATCH ABANDONED", while the separate checks ceiling (`checksCeilingMs`) has its own "budget spent" lead. Both are honest; the docs should name the difference.
4. Dashboard screenshots (the `/scripts` editor, run details with per-command results, the typed-outcome autocomplete in the branch editor) are pending a working Claude-in-Chrome session and can be attached to this document later.

## End state left on production

- Scripts config v14: `Blazity/ai-workflow` (legacy, verbatim), `Blazity/ai-workflow-prod` (legacy echo stubs restored), `Blazity/aiw-checks-fixture` (groups deps/lint/unit/verify/slow/envcheck/dirty/fail/hang, `gateGroups ["verify","envcheck"]`, `commandTimeoutMinutes: 15`, env `["AIW_FIXTURE_TOKEN"]`, no batch override).
- Definition 32 "Repository scripts QA" (disabled, manual dispatch only) stays as a reusable QA harness.
- QA tickets AWP-110..117 labeled `repository-scripts-qa`; fixture PRs #9 and #10 left open for inspection.
