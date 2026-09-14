Status: current
Last-verified: 2026-09-14

# Run capacity package (AIW-277, AIW-373, AIW-385)

First P0 package after the restructure. Scope decided with the owner on 2026-09-14 after a read-only recon of `main` at `3ecbf74ceb5925a360873a0725efa3af9940b7b2`.

## Problem

An operator has exactly one capacity limit, `MAX_CONCURRENT_AGENTS` (a settings row). Every path that starts a run must honour it and must say so when it refuses, otherwise a full pool looks like a dead cron (AIW-277's Arthur incident of 2026-08-13) or a lowered limit protects nothing (AIW-385's QA run of 2026-09-13).

Recon result: five of the six admission paths already honour the limit through one count (`PostgresRunRegistry.listCapacityConsumers`, parked claims included) and one vocabulary (`at_capacity`). The Jira ticket path already logs every refusal per tick, keeps a durable `dispatch_capacity_queue` row per queued ticket, posts one Jira comment per queue entry (bounded to 10 confirmed comments per tick, 120 s claim lease) and shows occupied slots plus the waiting list in the dashboard "Now running" panel (PR #291, 2026-08-16). The one path that ignores the limit is MCP manual dispatch: the production factory of MCP tool services binds the manual dispatch functions without the `maxConcurrentAgents` field, TypeScript accepts it because interface methods are checked bivariantly, and `count >= undefined` is always false.

## Solution

From the operator's side nothing new appears. What changes is that `workflows_dispatch_preflight` answers `at_capacity` and `workflows_dispatch` starts no run when every slot is taken, exactly like the dashboard already does, and the AIW-277 behaviour is confirmed on production and the ticket closed with the comment semantics the owner chose.

## User stories

1. As an operator I want a lowered `MAX_CONCURRENT_AGENTS` to bind manual dispatch through MCP the same way it binds the dashboard and the triggers, so that the sandbox budget is protected on every path.
2. As an agent using the MCP tools I want the preflight to tell me `at_capacity` before I dispatch, so that I can wait or pick another action instead of getting a silent overrun.
3. As a maintainer I want a binding that drops a required input to fail `pnpm run typecheck`, so that this class of defect cannot return silently.
4. As a client user I want a ticket that waits for a free slot to say so on the ticket and in the dashboard (AIW-277), so that I do not report a healthy worker as broken.

## Implementation decisions

- The limit is read from the settings snapshot the MCP transport already loads once per call and passes into the connected factory. No new snapshot load, no module level cache, no environment read.
- The `McpToolServices` members for manual dispatch preflight and dispatch become function typed properties instead of method shorthand, so the connected binding is checked contravariantly and a dropped input is a compile error.
- The regression test exercises the production factory, not the test factory. Preferred: one contract test parametrised over both factories asserting the same `at_capacity` behaviour at the pool boundary. Fallback if the connected factory cannot be built on the pglite test database: a focused test that mocks the manual dispatch service and asserts the connected wrappers pass the settings value and never `undefined`.
- No MCP tool schema changes; `mcp:contract:check` stays unchanged.
- AIW-277 comment semantics (owner decision 2026-09-14): keep the deployed at-least-once behaviour. A queue row exists before any comment attempt, `confirmed_at` is set only after the Jira call succeeds, and a failed send is retried on a later tick after the lease expires. A rare duplicate comment after a lost `confirmed_at` write is accepted; a lost comment is not, because silence is the defect the ticket exists for. The acceptance criterion in the ticket is corrected accordingly (comment first, then description edit).
- AIW-385 is the same defect as AIW-373 observed through `workflows.dispatch`; the dashboard path passes the limit correctly. It closes as a duplicate once AIW-373 is deployed and verified.

## Edge cases and expected behaviour

| Case | Expected |
|---|---|
| Pool full, MCP preflight | `blockers` contains `{code: "at_capacity", message: "All workflow execution slots are currently in use."}`, no reservation written |
| Pool full, MCP dispatch without preflight | `ManualDispatchError` 409 `at_capacity`, no `active_runs` row, `manual_dispatch_requests` row ends `failed` |
| Pool full because of parked (awaiting input) runs | Same as above: parked claims count as consumers on every path |
| One slot frees between preflight and dispatch | Dispatch succeeds; preflight is advisory, admission is decided at reservation time |
| Two MCP dispatches race for the last slot | One reserves, the other gets `at_capacity`; the reservation is the arbiter, not the preflight |
| Limit lowered below the number of live runs | No live run is cancelled; new admissions refuse until the count drops below the new limit |
| Limit raised | The next dispatch on any path sees the new value (each admission reads the snapshot of its own entry point) |
| `MAX_CONCURRENT_AGENTS` unset in settings | Registry default applies (3), identical on every path |
| Ticket queued for an hour, poll every 60 s (AIW-277) | One Jira comment, one `poll_dispatch_refused` log line per tick |
| Jira comment call fails (AIW-277) | Row stays unconfirmed, the comment is retried after the 120 s lease; at most one duplicate if the confirmation write itself is lost |
| Queued ticket leaves the AI column or starts | Queue row is reconciled away; a later re-queue is a new wait and gets a new comment |

## Seams and test decisions

- Seam: `McpToolServices` (`apps/worker/src/services/mcp/tool-services.ts`) built by the production factory (`services/mcp/connected-tool-services.ts`). Observed behaviour: `workflows_dispatch_preflight` and `workflows_dispatch` refuse with `at_capacity` when the count reaches the limit. Prior art: `services/manual-dispatch/service.test.ts` (dashboard path, 409 at capacity), `mcp/surface-e2e.test.ts` (real transport, mocked service).
- Seam: `capacityConsumerCount` over `listCapacityConsumers` (`services/dispatch/dispatch.ts`). Already tested in `dispatch.test.ts`; unchanged.
- Seam: `reconcileAtCapacityQueue` (`services/dispatch-queue/at-capacity-queue.ts`). Already tested (one comment across 14 ticks, retry on failure, per tick bound); unchanged.

## Out of scope

- Changing how many runs may execute at once or who may edit the limit (AIW-278, delivered by the settings work).
- Expiry of runs parked on clarification (AIW-279, AIW-280).
- A capacity outcome for schedule occurrences (deliberately an annotation on the pending occurrence, `skipReason: "at_capacity"`).
- A queue for non-ticket subjects (pull requests, webhooks); the queue table is keyed by ticket key on purpose.

## Assumptions

- The connected factory can be exercised in a test either against pglite or through a mocked service; the executor picks the first that works without widening the change.
- Production verification of AIW-277 uses the QA project (AWP), a limit of 1 and two tickets, and restores the limit afterwards; the evidence is the Jira comment on the second ticket, the `poll_dispatch_refused` log line and the dashboard panel showing 1/1 slots with one queued ticket.

## Stages

| # | Stage | Seam | File scope | Tier | Skeptic | TDD | Delegation | DoD |
|---|-------|------|------------|------|---------|-----|------------|-----|
| 1 | MCP manual dispatch honours the limit (AIW-373, AIW-385) | `McpToolServices` via the production factory | `apps/worker/src/services/mcp/connected-tool-services.ts`, `apps/worker/src/services/mcp/tool-services.ts`, new test beside them | sonnet | no | yes | no | `pnpm exec vitest run src/services/mcp src/mcp/tools/workflows.test.ts` green including the new pool boundary test; `pnpm run typecheck` green, and red when the wrapper is reverted; `pnpm run mcp:contract:check` unchanged; `git diff --check` clean |
| 2 | AIW-277 closure with evidence | none (verification and Jira) | Jira AIW-277 (comment, description), no code | advisor | no | no | no | Production run with limit 1: second ticket gets exactly one queued comment, one refusal log line per tick, dashboard shows the queue; limit restored; AIW-277 moved to Done, AIW-385 closed as duplicate after stage 1 deploys |

Stage 2 does not depend on stage 1 and runs as soon as production is quiet enough to hold the limit at 1 for a few minutes.
