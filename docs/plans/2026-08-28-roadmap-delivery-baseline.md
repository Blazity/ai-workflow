# Roadmap delivery baseline — 2026-08-28

This is the executable, evidence-conservative baseline for the 27 August 2026
roadmap. It maps its 20 domains (106 target outcomes) to the Jira backlog and
the source tree pinned below. It is not a release approval, deployment record,
or substitute for tenant evidence.

## Scope and evidence rules

- **Pinned source main:** b0e8a3d740462beca7dc68c4927dd489375f0486.
- The historical [2026-08-13 roadmap snapshot](../AI-WORKFLOW-ROADMAP.md),
  [Artur release flow](../releases/artur/README.md), and [rehearsal
  runbook](../releases/artur/rehearsals/README.md) remain the relevant
  repository references; this baseline does not overwrite them.
- PR #353 is an external concurrent workstream, excluded from this branch and
  this baseline. It has no gate or follow-up action here.
- A source deployment succeeding is not tenant verification. Unit or focused
  tests are not deployed evidence. A domain is **Verified** only when its
  stated, recorded gate has been met in the intended environment.
- Release/deploy approval remains a separate future decision. Nothing in this
  document authorizes an Arthur production release.

### Coverage legend

| Coverage status | Meaning |
| --- | --- |
| Verified | The prescribed gate has recorded evidence for the intended scope. |
| Implemented — tenant verification required | Current-main implementation evidence exists; the target-tenant gate remains. |
| Partial | Some current-main evidence exists, but required behavior or its gate is incomplete. |
| Missing | No representative current-main evidence was identified. |
| Blocked | Work or its gate cannot proceed because a required external prerequisite or governing input is absent. |
| Decision required | Product, policy, or operating-model decision must precede an implementable gate. |

## Jira audit

The audit contains **310** issues: **221 Gotowe**, **37 Backlog**, **33 Do
zrobienia**, and **19 Weryfikacja**. Therefore **89 are open**, and **74/89
open issues are unassigned**. Backlog is configured in an in-progress
category, so its name must not be read as an untouched queue. Open-to-open
Blocks links are effectively absent; sequencing below is an explicit delivery
choice, not a dependency graph inferred from Jira links.

Priority items are [AIW-121](https://blazity.atlassian.net/browse/AIW-121)
(Highest) and High: [AIW-182](https://blazity.atlassian.net/browse/AIW-182),
[AIW-187](https://blazity.atlassian.net/browse/AIW-187),
[AIW-258](https://blazity.atlassian.net/browse/AIW-258),
[AIW-260](https://blazity.atlassian.net/browse/AIW-260),
[AIW-277](https://blazity.atlassian.net/browse/AIW-277),
[AIW-279](https://blazity.atlassian.net/browse/AIW-279),
[AIW-284](https://blazity.atlassian.net/browse/AIW-284),
[AIW-310](https://blazity.atlassian.net/browse/AIW-310), and
[AIW-312](https://blazity.atlassian.net/browse/AIW-312).

## Roadmap coverage

Evidence paths establish that a capability is represented at the pinned SHA;
they do not prove live behavior. Jira keys are representative open work, not
newly created issues.

| Priority and domain (target) | Conservative coverage status | Representative current-main evidence | Open Jira keys | Next verifiable gate |
| --- | --- | --- | --- | --- |
| P0 — Prompt governance (6) | Partial | apps/worker/src/workflows/effective-prompt.ts; apps/worker/src/prompt-library/store.ts; apps/worker/src/workflow-definition/store.ts | AIW-243, AIW-267, AIW-285, AIW-300, AIW-303 | Record an effective-prompt/context provenance fixture covering feedback, no-op, repository selection, clarification, failed checks, and concurrent comments; then rerun it in the isolated tenant environment. |
| P0 — Tenant release verification (5) | Partial | .github/workflows/prepare-artur-release.yml; .github/workflows/sync-artur-release.yml; docs/releases/artur/upgrade-preflight.md | [AIW-229](https://blazity.atlassian.net/browse/AIW-229), [AIW-245](https://blazity.atlassian.net/browse/AIW-245), [AIW-250](https://blazity.atlassian.net/browse/AIW-250), [AIW-252](https://blazity.atlassian.net/browse/AIW-252), [AIW-260](https://blazity.atlassian.net/browse/AIW-260), AIW-281, AIW-288 | Produce one exact-SHA, isolated-environment rehearsal with migration result, isolated-tenant rerun evidence, and rollback drill; stop before any Arthur approval. AIW-229 is an operational billing/key check, not implementation work. |
| P0 — PR/MR feedback (6) | Partial | apps/worker/src/routes/webhooks/github.post.ts; apps/worker/src/routes/webhooks/gitlab.post.ts; apps/worker/src/lib/run-start-lifecycle.ts | AIW-108, AIW-291, [AIW-310](https://blazity.atlassian.net/browse/AIW-310) | Deterministic candidate E2E covers edited, concurrent, coalesced, and stale feedback; deployed provider smoke records one GitHub and one GitLab result. No open issue currently covers every comment-ledger/concurrency outcome. |
| P0 — Webhooks/integration health (6) | Partial | apps/worker/src/routes/webhooks/github.post.ts; apps/worker/src/routes/webhooks/gitlab.post.ts; apps/worker/src/routes/webhooks/jira.post.ts; apps/worker/src/webhook-trigger/dispatch-webhook-trigger.ts | AIW-223, AIW-272, AIW-282 | Isolated tenant onboarding check records configuration, authentication, test delivery, duplicate, delayed, and invalid-signature outcomes. Some roadmap health/history gaps have no dedicated open issue. |
| P0 — Failed-check remediation (6) | Partial | apps/worker/src/pre-pr-checks/config.ts; apps/worker/src/pre-pr-checks/runner.ts; apps/worker/src/lib/reconcile.ts | AIW-254, AIW-292, AIW-309, [AIW-310](https://blazity.atlassian.net/browse/AIW-310), AIW-311, [AIW-312](https://blazity.atlassian.net/browse/AIW-312) | Candidate E2E proves same-PR remediation, stale-head refusal, no-commit failure, retry stop, and visual failure manual handling. |
| P0 — Pre-PR/repository environments (6) | Partial | apps/worker/src/pre-pr-checks/config.ts; apps/worker/src/pre-pr-checks/runner.ts; apps/worker/src/workflows/blocks/prepare-workspace.ts | [AIW-260](https://blazity.atlassian.net/browse/AIW-260), AIW-283, [AIW-284](https://blazity.atlassian.net/browse/AIW-284), AIW-292, AIW-302, AIW-309, AIW-311 | Fixture repositories with distinct setup/runtime commands produce bounded redacted command evidence and preserve partial progress on budget exhaustion. |
| P0 — Runtime resilience (7) | Partial | apps/worker/src/lib/run-start-lifecycle.ts; apps/worker/src/lib/reconcile.ts; apps/worker/src/lib/run-stall-watchdog.ts | [AIW-229](https://blazity.atlassian.net/browse/AIW-229), AIW-254, AIW-268, [AIW-277](https://blazity.atlassian.net/browse/AIW-277), [AIW-279](https://blazity.atlassian.net/browse/AIW-279), AIW-280, AIW-289, AIW-292, [AIW-312](https://blazity.atlassian.net/browse/AIW-312) | Deterministic fault injection records bounded retries, typed diagnostic IDs, capacity outcome, termination ownership, clarification resume, and invalid-structured-response handling. |
| P1 — Explicit domain model (6) | Partial | apps/shared/contracts/workflow-graph.ts; apps/worker/src/workflow-definition/store.ts; apps/worker/src/workflows/blocks/prepare-workspace.ts | AIW-269, AIW-283, [AIW-284](https://blazity.atlassian.net/browse/AIW-284), AIW-285, AIW-295, AIW-298 | Contract review and deterministic fixture demonstrate linked ticket/repository/PR/comment/check/run selection, including an explicit multi-target choice. |
| P1 — Ticket/PR decomposition (5) | Partial | apps/worker/src/workflow-definition/block-registry.ts; apps/worker/src/workflows/blocks/prepare-workspace.ts; apps/worker/src/lib/run-start-lifecycle.ts | AIW-108, AIW-218, AIW-291, AIW-298, AIW-299, AIW-307 | Versioned lifecycle scenario proves ticket implementation and PR follow-up are separate workflows with explicit context resolution. |
| P1 — Trigger-owned configuration (5) | Partial | apps/worker/src/routes/webhooks/jira.post.ts; apps/worker/src/webhook-trigger/dispatch-webhook-trigger.ts; apps/worker/src/workflow-definition/store.ts | AIW-46, AIW-108, AIW-223, AIW-241, AIW-278, AIW-295, AIW-298 | Configurable trigger fixture proves project/column/repository scope and independent ticket, review, failed-check, schedule, and authenticated-webhook enablement. |
| P1 — Repository profiles (4) | Missing | Adjacent mechanisms: apps/worker/src/pre-pr-checks/config.ts; apps/worker/src/workflows/blocks/prepare-workspace.ts. No first-class repository profile was found. | No dedicated open Jira item; adjacent AIW-283, AIW-295, AIW-302, AIW-307 | Decide the profile contract, then validate versioned descriptions, relationships, reusable command groups, and audit history against two unlike repositories. |
| P2 — Typed workflow composition (8) | Partial | apps/shared/contracts/workflow-graph.ts; apps/worker/src/workflow-definition/block-registry.ts; apps/dashboard/components/cockpit/screens/workflow-editor.tsx | [AIW-121](https://blazity.atlassian.net/browse/AIW-121), AIW-152, [AIW-187](https://blazity.atlassian.net/browse/AIW-187), AIW-202, AIW-243, AIW-294, AIW-296, AIW-297, AIW-299, AIW-305, AIW-306 | Contract and editor fixture prove typed bindings, mandatory stop behavior, disconnect cleanup, JSON input, skills, and consistent parameter names. |
| P2 — Context/run transparency (6) | Partial | apps/worker/src/workflows/effective-prompt.ts; apps/worker/src/lib/run-start-lifecycle.ts; apps/dashboard/components/cockpit/screens/workflow-editor.tsx | AIW-243, AIW-285, AIW-298, AIW-300, AIW-301, AIW-302, AIW-303, AIW-309, [AIW-312](https://blazity.atlassian.net/browse/AIW-312) | Run evidence view exposes only bound context plus inputs, outputs, model, tools, repositories, decisions, and sandbox lifecycle provenance. |
| P2 — Permissions/onboarding (4) | Decision required | apps/dashboard/components/cockpit/screens/workflow-editor.tsx; apps/worker/src/routes/webhooks/jira.post.ts | [AIW-258](https://blazity.atlassian.net/browse/AIW-258), AIW-272, AIW-282, AIW-290, AIW-301 | Decide role/capability and access-request policy; validate denial, administrator route, SSO, capacity, and permission preflight. |
| P2 — Docs/reusable workflows (4) | Partial | apps/worker/src/workflow-definition/block-registry.ts; apps/worker/src/mcp/contracts.ts; [docs/testing/e2e-workflow-test-plan.md](../testing/e2e-workflow-test-plan.md) | AIW-194, AIW-195, AIW-196, AIW-197, AIW-198, AIW-199, AIW-224, AIW-286, AIW-288, AIW-307 | Publish reusable scenario definitions and execute GitHub/GitLab fixtures for multi-repository, comments, clarification, safety, migration, and rollback. |
| P2 — Operational dashboard (4) | Partial | apps/dashboard/components/cockpit/screens/workflow-editor.tsx; apps/worker/src/lib/run-start-lifecycle.ts | AIW-254, AIW-262, AIW-285, AIW-290, AIW-304, AIW-309, AIW-311, [AIW-312](https://blazity.atlassian.net/browse/AIW-312) | Isolated-environment run demonstrates attributed success/failure/retry/duration/cost/model/tenant evidence and separates it from charts. |
| P3 — Chat-agent integration (5) | Partial | apps/worker/src/mcp/contracts.ts; apps/worker/src/mcp/execute-tool.ts | AIW-239, AIW-272, AIW-282, AIW-286, AIW-291, AIW-307 | Scoped-auth candidate test dispatches typed inputs, answers clarification, retrieves structured result, and records a calling-agent evidence bundle. |
| P3 — Third-party integrations (4) | Decision required | apps/worker/src/mcp/contracts.ts; apps/worker/src/mcp/execute-tool.ts | AIW-14, AIW-47, AIW-48, AIW-49, AIW-224, AIW-290 | Decide extension contract and optional-provider boundaries; verify configured, disabled, unavailable, and misconfigured states. |
| P3 — Provider-neutral safety/observability (5) | Decision required | apps/worker/src/mcp/contracts.ts; apps/worker/src/mcp/execute-tool.ts; apps/worker/src/lib/reconcile.ts | AIW-6, AIW-7, AIW-11, AIW-19, AIW-22, AIW-60, AIW-70, [AIW-258](https://blazity.atlassian.net/browse/AIW-258), AIW-287, AIW-294, AIW-301, AIW-303 | Approve the provider-neutral policy/outcome contract, then prove typed pass/block/review, secret scanning, outbound policy logging, and provider failure behavior. |
| P3 — Hosted/on-prem execution (4) | Partial | [docs/ON-PREM-AWS.md](../ON-PREM-AWS.md); apps/worker/src/workflows/blocks/prepare-workspace.ts; apps/worker/src/lib/run-stall-watchdog.ts | AIW-43, AIW-82, AIW-278 | Compare one supported workflow across hosted and on-prem adapters, recording secrets, workspace transfer, cleanup, recovery, capacity, and operational ownership. |

## Delivery order

### Phase 0 — baseline and triage

Freeze this baseline, reconcile the 89 open keys to the groups below, assign the
first slice, and establish a lightweight evidence-bundle location. AGENTS.md
references @RTK.md, but no RTK.md exists anywhere in reachable git history.
This is an instruction-governance blocker: resolve the reference with its owner;
do not invent an RTK document or inferred rules.

### Phase 1 — release and isolated verification environment

The first execution/implementation slice is
[AIW-260](https://blazity.atlassian.net/browse/AIW-260), not a generic release
slice. Its actionable goal is to attest an isolated environment to the exact
source SHA and isolated database/tenant; make reset to a known state repeatable;
expose the deployed application version/source SHA, applied schema migration
identity, and workflow, model, and configuration identity; and keep production
targets out of scope. A failed smoke blocks demo-ready and release progression.

[AIW-229](https://blazity.atlassian.net/browse/AIW-229) is an operational
billing/key prerequisite, not implementation work. [AIW-252](https://blazity.atlassian.net/browse/AIW-252),
[AIW-245](https://blazity.atlassian.net/browse/AIW-245), refreshed
[AIW-250](https://blazity.atlassian.net/browse/AIW-250) scope, and AIW-281 are
supporting or follow-up work tied to their respective candidate, migration,
release-readiness, and recorded Jira gates; they do not replace the AIW-260
slice.

The Phase 1 executable order is: triage/assign AIW-260 → contract/fixture →
focused local gate → deterministic candidate E2E in CI → exact-SHA isolated
deployment (including schema preflight/migration readiness using the [upgrade
preflight](../releases/artur/upgrade-preflight.md)) → deployed browser/provider
smoke → isolated-tenant rerun → rollback drill/evidence review → separate
release/deploy approval decision. An Arthur target-tenant rerun may happen only
after a separately approved release/deploy. This document authorizes neither
deployment nor release.

### Phase 2 — contracts and security

Resolve the domain, repository-profile, permission, extension, and
provider-neutral safety decisions; start with Highest AIW-121 and the High
security contract work in AIW-258. No policy-dependent implementation starts
without its approved contract.

### Phase 3 — P0 reliability

Complete prompt provenance, feedback concurrency, integration health,
failed-check remediation, repository environment, and resilience scenarios
against the contracts from Phase 2.

### Phase 4 — executable scenario harness

Build and run deterministic candidate E2E fixtures for the open executable-test
work. Keep deployed browser/provider smoke separate: it uses an isolated tenant,
real provider configuration, and records evidence; it is not a replacement for
deterministic candidate E2E.

### Phase 5 — domain and multi-repository

Implement and verify explicit linked entities, target selection, trigger-owned
scope, repository profiles, and ticket/PR lifecycle decomposition.

### Phase 6 — builder, MCP, extensions, and on-prem

Deliver typed builder completion, transparent context/run evidence, safe MCP and
extension boundaries, and hosted/on-prem adapter parity only after the preceding
contracts and scenarios are proven.

## Ready, done, and pipeline

### Definition of Ready

- A Jira key is in one delivery phase, has a concrete acceptance scenario, and
  identifies its target tenant or deterministic fixture.
- The exact source SHA, workflow/schema/model/config versions, provider scope,
  test data owner, and cleanup boundary are known.
- Required product/policy decisions and any approval boundary are explicit.
- The change has focused local gates only; broad/full suites are reserved for CI.

### Delivery pipeline

triage/assign AIW-260 → contract/fixture → focused local gate → deterministic
candidate E2E in CI → exact-SHA isolated deployment (including schema
preflight/migration readiness) → deployed browser/provider smoke →
isolated-tenant rerun → rollback drill/evidence review → separate release/deploy
approval decision

Candidate E2E is deterministic, adapter-controlled, and runs in CI before the
exact-SHA isolated deployment. Deployed browser/provider smoke is a separate
verification of the isolated deployed environment and real provider wiring. CI
success advances confidence but does not replace either tenant rerun or a
release decision.

### Definition of Done

- The scoped scenario has a linked Jira key, reviewed change, focused local-gate
  result, and CI result.
- The target-environment gate has an evidence bundle with a successful tenant
  rerun, or the item remains **Implemented — tenant verification required** or
  **Partial**.
- Migration and rollback results are recorded when applicable; failures are
  linked to follow-up work rather than silently accepted.
- Any release/deploy approval is recorded as a separate decision after evidence
  review. No source or CI result implies it.

## Evidence bundle schema

Use one immutable bundle per candidate/tenant run. Redact secrets and sensitive
payloads while retaining correlation IDs.

| Field | Required evidence |
| --- | --- |
| Identity | Release ID, exact SHA, timestamp, tenant. |
| Version set | Application, workflow, schema, model, and configuration versions. |
| Correlation | Event, comment, check, and run IDs. |
| Provenance | Effective prompt and context provenance. |
| Results | Focused/deterministic and smoke results, plus redacted logs. |
| Change safety | Migration result, tenant rerun, approval if needed, and rollback evidence. |

## Appendix — all open Jira keys

This appendix is the coverage check for the 89 open items; a key may appear in a
domain row above as well, but is listed here at least once.

### Production/release/correctness

AIW-229, AIW-245, AIW-250, AIW-252, AIW-254, AIW-260, AIW-267, AIW-268, AIW-269, AIW-272, AIW-275, AIW-277, AIW-279, AIW-280, AIW-281, AIW-282, AIW-283, AIW-284, AIW-287, AIW-288, AIW-289, AIW-292, AIW-309, AIW-310, AIW-311, AIW-312.

### Security/trust

AIW-19, AIW-258, AIW-259, AIW-294, AIW-301, AIW-303.

### Builder/contracts/profiles

AIW-121, AIW-152, AIW-180, AIW-182, AIW-187, AIW-202, AIW-218, AIW-243, AIW-285, AIW-286, AIW-293, AIW-295, AIW-296, AIW-297, AIW-298, AIW-299, AIW-300, AIW-302, AIW-304, AIW-305, AIW-306, AIW-307.

### Triggers/capacity/MCP

AIW-108, AIW-223, AIW-239, AIW-241, AIW-278, AIW-290, AIW-291.

### Executable workflow tests

AIW-194, AIW-195, AIW-196, AIW-197, AIW-198, AIW-199, AIW-224.

### Observability/evals/cost

AIW-6, AIW-7, AIW-11, AIW-22, AIW-60, AIW-70, AIW-79, AIW-262.

### Future product

AIW-8, AIW-14, AIW-39, AIW-43, AIW-46, AIW-47, AIW-48, AIW-49, AIW-50, AIW-51, AIW-53, AIW-55, AIW-82.
