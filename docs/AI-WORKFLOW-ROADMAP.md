# AI Workflow Roadmap and Current Status

**Last updated:** 2026-08-12  
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

MCP is the planned control plane for workflow authoring, inspection, test dispatch, and run diagnosis. Arthur is the primary dogfooding deployment, while the source repository remains the place where shared product work is integrated and verified.

## Status on 2026-08-12

### Delivered

- [AI Workflow v2](./releases/artur/2026.08.0.md) was released to Arthur production on 2026-08-03 through the automated release pipeline.
- Jira-triggered execution, PR/MR creation, dashboard run visibility, GitHub and GitLab support, multi-repository execution, repository pinning, and repository allowlists are implemented.
- Generic authenticated webhooks and multiple webhook-triggered workflows are implemented.
- Post-PR review, finding aggregation, duplicate-review protection, run cancellation, Awaiting input, and resolved-ticket no-op behavior are implemented.
- The schedule/cron trigger is implemented; production behavior remains under verification.
- Deployment-owned skills are implemented and merged; final verification is tracked by [AIW-246](https://blazity.atlassian.net/browse/AIW-246).
- Phantom scheduled-run persistence was fixed and merged; production verification remains under [AIW-249](https://blazity.atlassian.net/browse/AIW-249).

### Integrating now

No additional product features should start during this stabilization pass.

| Work | Current state | Delivery evidence |
| --- | --- | --- |
| [AIW-239](https://blazity.atlassian.net/browse/AIW-239) — remote MCP endpoint | In progress | The frozen nine-tool surface is safely committed on its isolated branch. Contract/readiness, smoke verification, rebase, and final integration are actively being completed |
| [AIW-253](https://blazity.atlassian.net/browse/AIW-253) — truthful run model attribution | Merged / verification | [PR #247](https://github.com/Blazity/ai-workflow/pull/247); full repository CI and source deployments passed |
| [AIW-254](https://blazity.atlassian.net/browse/AIW-254) — actionable failure causes | Merged / verification | [PR #250](https://github.com/Blazity/ai-workflow/pull/250); full repository CI passed and failure causes are consistent across run views, Slack, and Jira |
| [AIW-255](https://blazity.atlassian.net/browse/AIW-255) — Arthur Engine, PromptRange, and EVALS scope | Merged / verification | [Scope document](./research/2026-08-12-arthur-engine-scope-and-evals.md), [PR #248](https://github.com/Blazity/ai-workflow/pull/248); full repository CI passed |
| [AIW-256](https://blazity.atlassian.net/browse/AIW-256) — trigger rate limits | Merged / verification | [PR #251](https://github.com/Blazity/ai-workflow/pull/251); enforcement is implemented across ticket, webhook, API, and schedule entry points; full repository CI and source preview passed |
| [AIW-257](https://blazity.atlassian.net/browse/AIW-257) — Jira and Slack investigation block | Merged / verification | [PR #251](https://github.com/Blazity/ai-workflow/pull/251); bounded Jira and Slack retrieval, evidence gaps, classification, and dashboard configuration are implemented; full repository CI and source preview passed |
| [AIW-263](https://blazity.atlassian.net/browse/AIW-263) — enforceable guardrails design | Merged / verification | [Guardrails design](./research/2026-08-12-workflow-guardrails.md), [PR #249](https://github.com/Blazity/ai-workflow/pull/249); this is a design dependency of AIW-258 |
| Arthur upgrade preflight documentation | Merged | [PR #243](https://github.com/Blazity/ai-workflow/pull/243); documentation only and does not release Arthur |

### Implemented, awaiting verification

- [AIW-221](https://blazity.atlassian.net/browse/AIW-221) — Arthur private repository-aware post-PR review workflow.
- [AIW-223](https://blazity.atlassian.net/browse/AIW-223) — schedule and cron trigger behavior.
- [AIW-244](https://blazity.atlassian.net/browse/AIW-244) — loop resume test coverage.
- [AIW-245](https://blazity.atlassian.net/browse/AIW-245) — deployed workflow schema and migration safety.
- [AIW-246](https://blazity.atlassian.net/browse/AIW-246) — deployment-owned skills.
- [AIW-249](https://blazity.atlassian.net/browse/AIW-249) — scheduled occurrence persistence.

### Existing release and CI gates

- [AIW-250](https://blazity.atlassian.net/browse/AIW-250) — run the Arthur tenant upgrade preflight and prepare the next controlled sync.
- [AIW-251](https://blazity.atlassian.net/browse/AIW-251) — eliminate the concurrent Workflow SDK replay-divergence failure.
- [AIW-252](https://blazity.atlassian.net/browse/AIW-252) — demonstrate a repeatably green Arthur CI and release candidate.

These gates are not a reason to start the Arthur release early. They are the checks that must be satisfied after the current source work is integrated and before the tenant release is approved.

### Planned, not started in this pass

- [AIW-258](https://blazity.atlassian.net/browse/AIW-258) — implement enforceable guardrails and approval for high-risk actions. Blocked by the separate AIW-263 design task.
- [AIW-259](https://blazity.atlassian.net/browse/AIW-259) — bounded screenshot, PDF, video, and Figma inputs.
- [AIW-260](https://blazity.atlassian.net/browse/AIW-260) — isolated client demo and workflow test environment.
- [AIW-261](https://blazity.atlassian.net/browse/AIW-261) — client-ready Zendesk and Sentry support investigation workflow. Depends on AIW-257.
- [AIW-262](https://blazity.atlassian.net/browse/AIW-262) — token usage and prompt-caching audit.

### Newly recorded QA follow-ups

The following findings are captured as separate Jira tasks and are not being pulled into the current stabilization implementation set:

- [AIW-264](https://blazity.atlassian.net/browse/AIW-264) — a Jira comment followed by moving the task back to AI does not resume an Awaiting input run.
- [AIW-265](https://blazity.atlassian.net/browse/AIW-265) — a dashboard clarification resumes processing while the Jira task remains in AI Backlog; expected status behavior must be confirmed and made consistent.
- [AIW-266](https://blazity.atlassian.net/browse/AIW-266) — Workflow Runs needs automatic refresh and a manual refresh fallback.
- [AIW-267](https://blazity.atlassian.net/browse/AIW-267) — compare two identical tickets that produced different clarification decisions and verify the resulting PR.

## Delivery sequence

### 1. Finish the current stabilization set

AIW-253, AIW-254, AIW-255, AIW-256, AIW-257, and AIW-263 are integrated into source `main` and in verification. Complete AIW-239 from its safely committed branch; it must still receive an isolated reviewable diff, focused regression evidence, repository CI, and an explicit Jira transition to verification before it is considered integrated.

Exit criteria:

- all branches in the current merge set are committed and reviewed;
- all in-scope PRs are merged to source `main`;
- no unique work is uncommitted or stranded; the active AIW-239 branch remains explicitly tracked;
- the source repository has a reproducible clean baseline;
- roadmap status matches Jira and merged code.

### 2. Verify the integrated source baseline

Confirm worker and dashboard deployments from source `main`, run the relevant smoke checks, and verify that model attribution, failure reporting, rate-limit refusals, investigation results, and MCP contract/readiness behavior are observable and consistent.

This phase verifies the shared product baseline. It is not the Arthur tenant release.

### 3. Prepare the next Arthur release candidate

After phases 1 and 2 are complete, prepare the evidence needed for a release decision:

1. satisfy the upgrade preflight in [AIW-250](https://blazity.atlassian.net/browse/AIW-250);
2. prove the release candidate through [AIW-251](https://blazity.atlassian.net/browse/AIW-251) and [AIW-252](https://blazity.atlassian.net/browse/AIW-252);
3. define the exact source range and expected Arthur release contents;
4. stop and request explicit approval to start the Arthur release.

Only after that explicit approval may the release flow generate a tenant release snapshot, create or merge the tenant release PR, deploy Arthur production, or run production smoke tests.

The source repository does not deploy Arthur production directly.

### 4. Resume planned product work

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
- remaining worktrees contain no unmerged unique product work;
- the Arthur release candidate scope is derived from the verified source baseline, not from an arbitrary local session;
- no Arthur sync, tenant release PR, tenant merge, or production deployment occurs without explicit approval;
- the final status message links this roadmap and distinguishes delivered, in verification, in progress, planned, and release-gated work.
