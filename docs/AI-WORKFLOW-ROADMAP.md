# AI Workflow Roadmap and Current Status

**Last updated:** 2026-08-13
**System of record:** [Jira AIW](https://blazity.atlassian.net/jira/software/c/projects/AIW/boards) and merged repository state

## Executive direction

AI Workflow is becoming a reliable, auditable workflow engine for engineering and support operations. The immediate objective is not to start another feature wave. It is to finish the work already in progress, integrate it into a clean source baseline, and prepare a release-ready Arthur candidate. The Arthur release itself requires separate, explicit approval and must not start before that approval is given.

The target operating flow is:

```text
Jira / Zendesk / Sentry / webhook / schedule
        -> bounded context gathering and investigation
        -> workflow execution
        -> PR, review, or proposed action
        -> human approval where required
        -> visible outcome in the dashboard, Jira, Slack, and GitHub/GitLab
```

MCP is now the control plane for workflow authoring, inspection, test dispatch, run diagnosis, clarification handling, cancellation, and controlled ticket writes. The shared source production deployment is the next dogfooding target. Arthur remains held until Filip approves; it must not be changed or deployed before then.

## Status on 2026-08-13

### Delivered

- [AI Workflow v2](./releases/artur/2026.08.0.md) was released to Arthur production on 2026-08-03 through the automated release pipeline.
- Jira-triggered execution, PR/MR creation, dashboard run visibility, GitHub and GitLab support, multi-repository execution, repository pinning, and repository allowlists are implemented.
- Generic authenticated webhooks and multiple webhook-triggered workflows are implemented.
- Post-PR review, finding aggregation, duplicate-review protection, run cancellation, Awaiting input, and resolved-ticket no-op behavior are implemented.
- The schedule/cron trigger is implemented; production behavior remains under verification.
- Deployment-owned skills are implemented and merged; final verification is tracked by [AIW-246](https://blazity.atlassian.net/browse/AIW-246).
- Phantom scheduled-run persistence was fixed and merged; production verification remains under [AIW-249](https://blazity.atlassian.net/browse/AIW-249).
- The remote MCP surface is integrated on source `main`. The committed/local target remains 22 tools, 11 public error codes, and contract hash `881de2fae17a183a44645d8d6c6c8c8089e604fcc2197d98d4f27acb66ec2f7b`; the 11-error count is a committed/local contract fact because the runtime does not expose that count.
- The canonical MCP endpoint, [https://ai-workflow-app-eight.vercel.app](https://ai-workflow-app-eight.vercel.app), now points to deployment `dpl_AkQTJ5NGN6kPa19vqRS5ZFLpayzu` at commit `ca0fce777e19e4a4f248fb1018fbba4060cf0288`; pre-auth smoke is healthy. `GET /mcp` returns 405, unauthenticated initialize returns 401, and wrong-scope access returns `INSUFFICIENT_SCOPE`.
- Authenticated production MCP is verified through the signed-in Chrome session handoff: DCR, PKCE S256, consent for `mcp:read`, token issuance, and authenticated initialization completed without relogin. `initialize` returned 200 with MCP protocol `2025-11-25` and server `ai-workflow-worker@0.1.0`; `tools/list` returned exactly 22 matching names with contract hash `881de2fae17a183a44645d8d6c6c8c8089e604fcc2197d98d4f27acb66ec2f7b`; read-only `workflows.list(limit=1)` returned 200.
- Signed-in dashboard sessions now bridge to MCP consent through a one-minute, single-use, hashed handoff token; raw session tokens stay server-side. AIW-273 is verified through the interactive signed-in Chrome OAuth handoff.
- The Vercel MCP bundle now inlines its Zod 3 contract dependency. The canonical source-production endpoint no longer crashes before auth; the zod/v3 pre-auth crash is fixed and AIW-276 is production verified.
- AIW-274 is implemented and merged. Its 110 focused tests and worker typecheck passed; the real live Jira/DB finalization race remains part of stress verification.
- Dashboard run refresh, Jira clarification synchronization, repository-selection recovery, and running-run backstops are merged.

### Integrating now

No additional product features should start during this stabilization pass.

| Work | Current state | Delivery evidence |
| --- | --- | --- |
| [AIW-239](https://blazity.atlassian.net/browse/AIW-239) — remote MCP endpoint | Merged / production verified | [PR #256](https://github.com/Blazity/ai-workflow/pull/256), [PR #263](https://github.com/Blazity/ai-workflow/pull/263), [PR #267](https://github.com/Blazity/ai-workflow/pull/267), and [PR #271](https://github.com/Blazity/ai-workflow/pull/271); authenticated production contract verification is complete on the canonical source deployment |
| [AIW-270](https://blazity.atlassian.net/browse/AIW-270) — MCP OAuth consent | Merged / production verified | [PR #262](https://github.com/Blazity/ai-workflow/pull/262), [PR #264](https://github.com/Blazity/ai-workflow/pull/264), [PR #266](https://github.com/Blazity/ai-workflow/pull/266), and [PR #268](https://github.com/Blazity/ai-workflow/pull/268); DCR, consent, PKCE S256, token exchange, and authenticated initialize succeeded through the signed-in Chrome handoff |
| [AIW-273](https://blazity.atlassian.net/browse/AIW-273) — reuse the signed-in dashboard session for MCP authorization | Merged / verified | [PR #273](https://github.com/Blazity/ai-workflow/pull/273); interactive signed-in Chrome OAuth handoff verified without relogin |
| [AIW-274](https://blazity.atlassian.net/browse/AIW-274) — manual AI Review move falsely succeeds an unfinished run | Implementation done / stress verification pending | [PR #275](https://github.com/Blazity/ai-workflow/pull/275), merge `bbdcc5ac`; 110 focused tests and worker typecheck passed. A real live Jira/DB finalization race remains to be verified in the stress campaign |
| [AIW-276](https://blazity.atlassian.net/browse/AIW-276) — production MCP bundle omitted `zod/v3` | Merged / production verified | [PR #274](https://github.com/Blazity/ai-workflow/pull/274); the zod/v3 Vercel pre-auth crash was fixed and canonical `/mcp` reaches the auth layer. Authenticated production `tools/list` and exact-hash verification are complete; the 11-error count remains committed/local contract evidence because runtime does not expose it |
| [AIW-271](https://blazity.atlassian.net/browse/AIW-271) — permanent RUNNING and phantom starts | Merged / cleanup verified | [PR #269](https://github.com/Blazity/ai-workflow/pull/269) and [PR #277](https://github.com/Blazity/ai-workflow/pull/277); the narrow cleanup command, not `/cron/poll`, moved the exact four reported rows to `blocked`, found zero orphan rows, and left AWP-66, AWP-67, and AWP-71 unchanged |
| [AIW-251](https://blazity.atlassian.net/browse/AIW-251) — concurrent SDK replay and CI safety | Merged / focused verification | [PR #260](https://github.com/Blazity/ai-workflow/pull/260), [PR #270](https://github.com/Blazity/ai-workflow/pull/270), and [PR #272](https://github.com/Blazity/ai-workflow/pull/272); deterministic focused tests pass, with local checks and smoke evidence serving as acceptance evidence |
| [AIW-253](https://blazity.atlassian.net/browse/AIW-253) — truthful run model attribution | Merged / verification | [PR #247](https://github.com/Blazity/ai-workflow/pull/247); full repository CI and source deployments passed |
| [AIW-254](https://blazity.atlassian.net/browse/AIW-254) — actionable failure causes | Merged / verification | [PR #250](https://github.com/Blazity/ai-workflow/pull/250); full repository CI passed and failure causes are consistent across run views, Slack, and Jira |
| [AIW-255](https://blazity.atlassian.net/browse/AIW-255) — Arthur Engine, PromptRange, and EVALS scope | Merged / verification | [Scope document](./research/2026-08-12-arthur-engine-scope-and-evals.md), [PR #248](https://github.com/Blazity/ai-workflow/pull/248); full repository CI passed |
| [AIW-256](https://blazity.atlassian.net/browse/AIW-256) — trigger rate limits | Merged / verification | [PR #251](https://github.com/Blazity/ai-workflow/pull/251); enforcement is implemented across ticket, webhook, API, and schedule entry points; full repository CI and source preview passed |
| [AIW-257](https://blazity.atlassian.net/browse/AIW-257) — Jira and Slack investigation block | Merged / verification | [PR #251](https://github.com/Blazity/ai-workflow/pull/251); bounded Jira and Slack retrieval, evidence gaps, classification, and dashboard configuration are implemented; full repository CI and source preview passed |
| [AIW-261](https://blazity.atlassian.net/browse/AIW-261) — Zendesk and Sentry investigation workflow | Merged / verification | [PR #257](https://github.com/Blazity/ai-workflow/pull/257); real-run scenario verification is intentionally deferred to the controlled stress-test campaign |
| [AIW-263](https://blazity.atlassian.net/browse/AIW-263) — enforceable guardrails design | Merged / verification | [Guardrails design](./research/2026-08-12-workflow-guardrails.md), [PR #249](https://github.com/Blazity/ai-workflow/pull/249); this is a design dependency of AIW-258 |
| Arthur upgrade preflight documentation | Merged | [PR #243](https://github.com/Blazity/ai-workflow/pull/243); documentation only and does not release Arthur |

### Implemented, awaiting verification

- [AIW-221](https://blazity.atlassian.net/browse/AIW-221) — Arthur private repository-aware post-PR review workflow.
- [AIW-223](https://blazity.atlassian.net/browse/AIW-223) — schedule and cron trigger behavior.
- [AIW-244](https://blazity.atlassian.net/browse/AIW-244) — loop resume test coverage.
- [AIW-245](https://blazity.atlassian.net/browse/AIW-245) — deployed workflow schema and migration safety.
- [AIW-246](https://blazity.atlassian.net/browse/AIW-246) — deployment-owned skills.
- [AIW-249](https://blazity.atlassian.net/browse/AIW-249) — scheduled occurrence persistence.
- [AIW-265](https://blazity.atlassian.net/browse/AIW-265) and [AIW-267](https://blazity.atlassian.net/browse/AIW-267) — clarification resume consistency, merged in [PR #258](https://github.com/Blazity/ai-workflow/pull/258) with the repository-selection follow-up in [PR #265](https://github.com/Blazity/ai-workflow/pull/265).
- [AIW-266](https://blazity.atlassian.net/browse/AIW-266) — active run refresh, merged in [PR #261](https://github.com/Blazity/ai-workflow/pull/261).

### Existing release gates

- [AIW-250](https://blazity.atlassian.net/browse/AIW-250) — run the Arthur tenant upgrade preflight and prepare the next controlled sync.
- [AIW-251](https://blazity.atlassian.net/browse/AIW-251) — confirm the merged concurrent Workflow SDK replay-divergence fix with focused local tests, typechecks, build checks, and smoke evidence.
- [AIW-252](https://blazity.atlassian.net/browse/AIW-252) — demonstrate a repeatably green Arthur release candidate through its approved release checks; CI is informational, not the acceptance gate.

These gates are not a reason to start the Arthur release early. They are the checks that must be satisfied after the current source work is integrated and before the tenant release is approved.

### Planned, not started in this pass

- [AIW-258](https://blazity.atlassian.net/browse/AIW-258) — implement enforceable guardrails and approval for high-risk actions. Blocked by the separate AIW-263 design task.
- [AIW-259](https://blazity.atlassian.net/browse/AIW-259) — bounded screenshot, PDF, video, and Figma inputs.
- [AIW-260](https://blazity.atlassian.net/browse/AIW-260) — isolated client demo and workflow test environment.
- [AIW-262](https://blazity.atlassian.net/browse/AIW-262) — token usage and prompt-caching audit.

### Newly recorded QA follow-ups

The following findings are captured as separate Jira tasks. Arthur observations are compared with source `main` before implementation so an outdated tenant result is not mistaken for a new source regression:

- [AIW-264](https://blazity.atlassian.net/browse/AIW-264) — the Jira-comment clarification resume fix is merged in source [PR #254](https://github.com/Blazity/ai-workflow/pull/254); Patrycja's Case 4 is expected on the older Arthur deployment and requires a retest only after a separately approved release.
- [AIW-265](https://blazity.atlassian.net/browse/AIW-265) — a dashboard clarification resumes processing while the Jira task remains in AI Backlog; expected status behavior must be confirmed and made consistent.
- [AIW-266](https://blazity.atlassian.net/browse/AIW-266) — Workflow Runs needs automatic refresh and a manual refresh fallback.
- [AIW-267](https://blazity.atlassian.net/browse/AIW-267) — compare two identical tickets that produced different clarification decisions and verify the resulting PR.
- [AIW-274](https://blazity.atlassian.net/browse/AIW-274) — Patrycja's Case 5 is reproduced by current source semantics: a premature human move from AI to AI Review can be preserved as success even when no meaningful work or PR exists.
- [AIW-275](https://blazity.atlassian.net/browse/AIW-275) — Patrycja's Case 6 needs an explicit product rule for a direct AI Backlog to AI Review transition with no associated run; the preferred handling is visible rejection without a phantom failed run.

## Delivery sequence

### 1. Finish the current stabilization set

AIW-271, AIW-273, AIW-274, and AIW-276 are integrated into source `main`; AIW-271 cleanup and authenticated MCP verification are complete. The remaining work is to settle the AIW-275 product rule, reconcile Jira statuses, and record the controlled stress-test evidence, including the live AIW-274 Jira/DB finalization race. Focused local tests, typechecks, generated-artifact checks, production build checks, and combined-main smoke tests are the source acceptance evidence; CI is not the acceptance gate.

Exit criteria:

- all branches in the current merge set are committed and reviewed;
- all in-scope PRs are merged to source `main`;
- no unique work is uncommitted or stranded in an active implementation worktree;
- the source repository has a reproducible clean baseline;
- roadmap status matches Jira and merged code.

### 2. Verify the integrated source baseline

Confirm worker and dashboard deployments from source `main`, run the relevant smoke checks, and verify that model attribution, failure reporting, rate-limit refusals, investigation results, and MCP contract/readiness behavior are observable and consistent.

This phase verifies the shared product baseline. It is not the Arthur tenant release.

### 3. Run the controlled real-run stress campaign

After the integrated source baseline is green, execute the separate [production MCP stress-test plan](./testing/production-mcp-stress-test-plan.md) against a dedicated non-Arthur test scope. Agents use MCP as the control and evidence plane, with Jira, Slack, and provider MCP tools only where a scenario requires an external trigger.

The campaign must cover real workflow authoring, dispatch, Jira and Slack investigation, human input, cancellation, schedules, webhooks, PR events, rate limits, idempotency, concurrency, recovery, observability, and cleanup. Findings are first reproduced and deduplicated, then converted into Jira defects. Fixes and regression re-runs happen in a separate wave so test evidence is never gathered against a moving deployment.

### 4. Prepare the next Arthur release candidate

After phases 1 through 3 are complete, prepare the evidence needed for a release decision:

1. satisfy the upgrade preflight in [AIW-250](https://blazity.atlassian.net/browse/AIW-250);
2. prove the release candidate through [AIW-251](https://blazity.atlassian.net/browse/AIW-251) and [AIW-252](https://blazity.atlassian.net/browse/AIW-252);
3. define the exact source range and expected Arthur release contents;
4. stop and request explicit approval to start the Arthur release.

Only after Filip's explicit approval may the release flow generate a tenant release snapshot, create or merge the tenant release PR, deploy Arthur production, or run production smoke tests. Arthur remains held until then.

The source repository does not deploy Arthur production directly.

### 5. Resume planned product work

Only after the stabilization and Arthur release gates are complete should the next feature set be promoted:

- guardrail enforcement — AIW-258;
- richer inputs — AIW-259;
- isolated client test environment — AIW-260;
- support investigation workflow — AIW-261;
- usage and caching audit — AIW-262.

## Product boundaries

### Arthur Engine and EVALS

The current product boundary, PromptRange unknowns, and EVALS verification status are maintained in the separate [Arthur Engine scope and EVALS document](./research/2026-08-12-arthur-engine-scope-and-evals.md) under [AIW-255](https://blazity.atlassian.net/browse/AIW-255).

### Workflow guardrails

The enforceability model, allowed/blocked/approval matrix, deterministic enforcement points, and AIW-258 implementation brief are maintained in the separate [workflow guardrails design](./research/2026-08-12-workflow-guardrails.md) under [AIW-263](https://blazity.atlassian.net/browse/AIW-263).

AIW-255 and AIW-263 are intentionally separate tasks and documents. AIW-258 is the later implementation task; it is not part of the current stabilization pass.

## Definition of a clean handoff

The current pass is complete when:

- every active task is merged or has a clearly recorded temporary blocker;
- Jira, the roadmap, and repository state agree;
- source deployments are verified;
- the controlled real-run stress campaign has a recorded result for every required scenario, every discovered defect has a Jira key, and all test data has an owner and cleanup state;
- remaining worktrees contain no unmerged unique product work;
- the Arthur release candidate scope is derived from the verified source baseline, not from an arbitrary local session;
- no Arthur sync, tenant release PR, tenant merge, or production deployment occurs without explicit approval;
- the final status message links this roadmap and distinguishes delivered, in verification, in progress, planned, and release-gated work.
