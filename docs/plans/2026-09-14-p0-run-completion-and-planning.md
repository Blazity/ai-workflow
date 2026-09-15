Status: current
Last-verified: 2026-09-14

# P0 package: run completion fields and the planning expansion loop (AIW-369, AIW-377)

Second P0 package after the restructure, planned on 2026-09-14 from a read-only recon of `main` at `2dce571943cdfc3d72650f464201c7103f4642ed`. Both defects were found in production QA runs and both make a healthy run look broken to the person watching it.

## Problem

1. AIW-369: a run reaches `status: success` before its completion fields exist. The status flip is a status-only update in the self-move step; `completedAt`, `durationSec`, `prs`, `workflowId` and `workflowName` land later in the end-of-run telemetry step. Between the two, `runs.result` returns `terminal: true` with `prs: null` and `pollAfterMs: null`, so an agent stops polling and reads a success without its pull request. `runs.get` and `tickets.list_runs` already expose `completionPending`; `runs.result` computes it and ignores it.
2. AIW-377: when the planning agent asks for a repository that is already attached (typically because the research checkout is labelled read-only and the ticket asks for a merge request), the expansion validator checks the round limit before the already-attached filter. After two no-op rounds the third request trips the limit and parks the run on the question "which additional repository is required?", which no human can answer. An answer naming the attached repository or nothing at all falls through with the round counter unchanged, so the same question can come back.

## Solution

From the user's side: a successful run shows its pull request the first time it is read as finished, and a ticket that names its one attached repository plans and implements without asking anyone for more repositories. Nothing new to configure.

## User stories

1. As an agent using `runs.result` I want `result` to be withheld and `pollAfterMs` to be set while the completion fields are still pending, so that I never act on a success without its pull requests.
2. As an operator I want a successful run to carry `completedAt` and `durationSec` from the moment it is marked successful, so that the dashboard and MCP reads agree without waiting for the poll cron.
3. As a maintainer I want a lost end-of-run write to be visible in the logs with the run id and in `runs.diagnose`, so that silence is never the failure mode.
4. As a client user I want a ticket that names the repository already attached to the run to proceed to planning, so that a read-only research checkout never turns into a clarification.
5. As a client user I want my answer "no more repositories" to move the run forward, so that the same question is never asked twice.

## Implementation decisions

- AIW-369, statement level: the self-move success update stamps `completedAt` and `durationSec` in the same statement that flips the status, and the four other status-only terminal writers do the same. The later telemetry write keeps `coalesce(existing, now())` for both, so the earlier stamp wins and the two writers still converge. A slightly shorter duration (the tail after the status flip is not counted) is accepted. One writer does override both fields afterwards: the poll cron's snapshot upsert takes `completed_at` and `duration_sec` straight from the Workflow world whenever the world reports them, so a run the cron still observes ends up with the world's numbers rather than the flip's.
- AIW-369, read level: `completionPending` is one shared predicate (`isRunCompletionPending`, `apps/worker/src/services/mcp/contracts.ts`) reported by `runs.get`, `runs.result` and `tickets.list_runs` and classified by `runs.diagnose`: a stopped AGENT run whose own end-of-run write has not landed. It reads `cost_known`, which that write alone sets, and not `completed_at`, which the status flip stamps minutes earlier. Post-PR gate rows, which the poll cron snapshots into the same table and which never get such a write, answer false; so does a live park. `runs.result` withholds `result` for a pending SUCCESS only, returning `pollAfterMs: 15000` and `pendingUntil`; failed and blocked runs report the flag truthfully and always return their result. Rows written by older code stay honest through this gate.
- AIW-369, visibility: the swallowed failures named in the recon log at error level with the run id through the module's existing logger; the workflow-bundle `console.error` stays where the bundle constraint forbids the logger. `runs.diagnose` already has `completion_fields_pending` and keeps it.
- AIW-377, validator order: the already-attached filter runs before the round limit, so an all-attached request never reaches the limit branch. The AIW-284 no-op branch stays and is reached earlier. A separate bound on consecutive all-attached requests (3) prevents a model that keeps asking for attached repositories from looping forever; hitting it proceeds to planning with the attached set, it never parks.
- AIW-377, human answer: an answer that names no new repository (empty, "none", "no more", or only already-attached names) is an explicit "no further repositories": the resume sets a flag that skips expansion for the rest of the run and proceeds to planning. It never raises a second clarification.
- AIW-377, prompt: the sandbox context tells the model that a read-only research checkout is promoted to a writable checkout for implementation, so write intent never justifies an expansion request.
- No block contract, no MCP tool schema and no `"use step"` name or path changes. If a schema field is added to `runs.result` (`completionPending`), the MCP contract hash is updated in the same change and `mcp:contract:check` passes.

## Edge cases and expected behaviour

| Case | Expected |
|---|---|
| Run marked success, telemetry step still pending | `runs.result` returns no `result`, `completionPending: true`, `pollAfterMs` 15000 and `pendingUntil` set; `runs.get` reports the same flag |
| Post-PR gate run snapshotted by the cron, no end-of-run write ever | `completionPending: false` everywhere; `runs.result` returns its result at once |
| Telemetry step exhausted its retries | error log with run id; `runs.diagnose` reports `completion_fields_pending`; `runs.result` keeps withholding until the grace expires, then returns the result with `completionPending: true` |
| Run failed or blocked (no self-move) | Completion fields come from the telemetry step as today; nothing changes |
| Old row: success with `cost_known` null written before this deploy | `runs.result` withholds only while the row is inside the grace; an older one returns its result at once, flagged pending |
| Planning asks for the one attached repository, round 0 | No-op, no clarification, planning proceeds with the attached set |
| Planning asks for attached repositories three times in a row | Third time proceeds to planning; no clarification |
| Planning asks for a genuinely missing repository after two rounds | Existing limit clarification stays (that question has an answer) |
| Human answers the limit question with no new repository | Run resumes into planning, expansion disabled for the run, no second question |
| Human answers with a new repository path | Existing attach path, unchanged |
| Read-only research checkout, ticket asks for a merge request | Prompt says implementation gets a writable checkout; model is not expected to request the same repository |

## Seams and test decisions

- Seam: `recordRunUsage` and the self-move update in `apps/worker/src/db/repositories/runs/telemetry.ts`. Observed: after the self-move success update the row has `completedAt` and `durationSec`; a later `recordRunUsage` keeps BOTH of the earlier values. Prior art: `apps/worker/src/db/repositories/runs/telemetry.test.ts` (two-writer convergence).
- Seam: `runs.result` in `apps/worker/src/mcp/tools/runs.ts`. Observed: an agent success row with null `cost_known` yields no `result`, `completionPending: true`, `pollAfterMs` 15000 and a `pendingUntil`, while a Post-PR gate row in the same shape returns its result at once. Prior art: `apps/worker/src/mcp/tools/runs.test.ts` (`completionPending` tables).
- Seam: `validateRepositoryExpansionRequests` and `validateHumanRepositoryExpansion` in `apps/worker/src/engine/repository-discovery/runner.ts`, pure functions. Observed: all-attached requests return the no-op verdict regardless of rounds; a human answer naming nothing new returns an explicit "no further repositories" verdict. Prior art: `apps/worker/src/services/repository-discovery/runner.test.ts`, `runner.matrix.test.ts`.
- Seam: the resume path `applyHumanRepositoryExpansion` in `apps/worker/src/engine/steps/phase.ts` and the loop in `apps/worker/src/engine/agent-workflow.ts`. Observed: the run proceeds and expansion is disabled. Prior art: `apps/worker/src/engine/tests/multi-repo-research.test.ts` (resume cases).

## Out of scope

- Moving the end-of-run telemetry into a new step or re-architecting the workflow tail (already durable with retries).
- Expiry of runs parked on clarification (AIW-279, AIW-280).
- The AIW-284 semantics for a clarification that has an answer (a genuinely missing repository).

## Assumptions

- Stamping `completedAt` at the self-move flip is acceptable even though later steps still run; the field means "the run's outcome is decided", which is what every reader uses it for.
- Three consecutive all-attached requests is a reasonable bound; the owner may lower it.
- The prompt sentence about writable implementation checkouts is enough to stop the request in most runs; the validator change is the guarantee.

## Known limits

- `pendingUntil: null` carries two different meanings on a `runs.result` reply: the wait expired, and there was never a wait. The field alone does not separate them, and nothing in the reply does; `completionPending` plus `result` tells a reader which one it is (pending with a result means expired), and the tool description says so in prose. A caller that wants one field to answer it needs a third state, which is a contract change nobody has asked for.
- A rejected plan approval settles the parked run through `resolveAwaitingRun`, which writes `success` on a run that shipped nothing. Its usage was already recorded when the run parked, so `completionPending` is false and `runs.result` hands back a success with no pull request. That predates this change and the flag is honest about what it measures (the end-of-run write landed); calling a rejected plan something other than success is its own ticket.

## Stages

| # | Stage | Seam | File scope | Tier | Skeptic | TDD | Delegation | DoD |
|---|-------|------|------------|------|---------|-----|------------|-----|
| 1 | AIW-369: completion stamp at the status flip, `runs.result` honours `completionPending`, error logs with run id | telemetry repository, `runs.result` | `apps/worker/src/db/repositories/runs/telemetry.ts`, `apps/worker/src/engine/steps/telemetry.ts`, `apps/worker/src/mcp/tools/runs.ts`, `apps/worker/src/mcp/tool-catalog.ts`, their tests, `apps/worker/src/mcp/contracts/mcp-contract.json` if a field is added | opus | yes | yes | no | `pnpm exec vitest run src/db/repositories/runs/telemetry.test.ts src/mcp/tools/runs.test.ts src/engine/steps/telemetry.test.ts` green with the new cases; `pnpm run mcp:contract:check` green; `pnpm run typecheck` green; `git diff --check` clean |
| 2 | AIW-377: validator order and bound, explicit "no further repositories" on resume, prompt sentence | expansion validator, resume path | `apps/worker/src/engine/repository-discovery/runner.ts`, `apps/worker/src/engine/steps/phase.ts`, `apps/worker/src/engine/agent-workflow.ts` (expansion closure and resume only), `apps/worker/src/sandbox/context.ts` (one sentence), their tests | opus | yes | yes | no | `pnpm exec vitest run src/services/repository-discovery src/engine/tests/multi-repo-research.test.ts` green with the new cases; `pnpm exec vitest run src/engine/workflow-import-boundary.test.ts src/engine/step-registration-coverage.test.ts` green; `pnpm run typecheck` green; `git diff --check` clean |

File scopes are disjoint, so both stages run in parallel. Production verification after deploy: stage 1 by reading `runs.result` right after the status node of a QA run completes (ten runs is the ticket's bar, the first five count as the gate here) and stage 2 by re-running the AWP-175 shape (one attached repository, merge request requested) and observing no clarification.

## Pre-mortem outcomes (2026-09-14, skeptic lane)

1. Blocker, accepted: the `runs.result` gate applies to `status === "success"` only. Failed and blocked rows are written by status-only writers and never get `completedAt`; gating them would make an agent poll forever. `runs.get` keeps reporting `completionPending` as information.
2. Blocker, accepted: the poll cron fills only runs the Workflow DevKit still lists, so an old success row can stay incomplete. The gate therefore expires on a wall clock: a success row pending for more than 15 minutes returns its result with `completionPending: true` instead of withholding it. The clock is anchored at `completedAt`, falling back to `startedAt` then `createdAt`; `updatedAt` would be the exact instant but is not part of `RunDetail`, and the flip writes the completion stamp in the same statement as the status anyway. Fifteen minutes because the deployed step function is killed at 800 s, so a tail that is going to arrive has arrived by then.
3. Blocker, accepted: the bound on consecutive all-attached requests lives in the run context (`ctx.repositoryExpansion.allAttachedRequests`), maintained by the expansion closure, and is passed into the pure validator as an input. On the third such request the closure returns the proceed verdict and the planning loop exits into planning with the attached set. The limit clarification stays the exit for requests that name a missing repository.
4. Major, accepted as an operational step: runs parked on the expansion limit clarification when this deploys resume through a different branch sequence (replay hazard). Before merge the advisor lists awaiting runs on production and cancels the ones parked on that clarification (QA project tickets), recording the run ids in the pull request.
5. Major, accepted with a documented consequence: `completedAt` also starts the reconciler's five-minute claim-release clock (`STALE_RESERVATION_MS`, `apps/worker/src/services/run-lifecycle/reconcile.ts`). Stamping it at the status flip moves that release earlier by the length of the workflow tail (notifications, check closing, telemetry). That branch is safe only because it does not release on the clock alone: `cleanStoreTerminalRun` releases the subject after `confirmWorkflowStepsDrained` reports no step still executing, so a tail that outlives the five minutes keeps the claim. Anything that weakens that drain check turns this stamp into an early release.
6. Major, accepted: `mcp:contract:check` covers input schemas only; it is not evidence for this change. The tests are.
7. Major, deferred to the gate refactor: the engine canary throws on `completionPending`; after this change new success rows are never pending, and the canary will poll instead of throwing in the gate refactor stage 3.
8. Minor, accepted: stage 2 scope adds `apps/worker/src/sandbox/context.test.ts`; the runner tests live under `apps/worker/src/services/repository-discovery/`.

Owner-visible decisions taken by the advisor: the bound of three consecutive all-attached requests; `pollAfterMs` is positive on a success row whose completion is pending even though `terminal` is true (the existing test asserting null for terminal rows is updated for this one case); `durationSec` stops at the status flip; the withheld reply also carries `pendingUntil`, the instant the wait expires.
