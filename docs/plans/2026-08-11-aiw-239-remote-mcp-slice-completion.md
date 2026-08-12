# Remote MCP: completing the first vertical slice

**Date:** 2026-08-11
**Branch:** `feat/ai-workflow-remote-mcp` (worktree `.worktrees/ai-workflow-remote-mcp`). The base today is `092ba523`, that is twelve commits behind `origin/main`; stage `A0` moves the branch onto `origin/main`.
**Input:** `docs/plans/2026-08-11-aiw-239-remote-mcp-design.md`, `docs/plans/2026-08-11-aiw-239-remote-mcp-first-slice.md`
**This document supersedes** that plan for Tasks 6-13. Tasks 1-5 are done and green.

## Problem

An agent in Claude Code or Codex has no way to work on AI Workflow without the dashboard. To see why a run failed you have to open a browser, find the run, click through the trace. To start a workflow you have to click in the UI. The agent that is supposed to fix the problem is cut off from context it could fetch for itself.

## Solution

The worker exposes `https://<worker>/mcp`. The agent connects that address once, goes through OAuth in the browser, and from then on, from inside its chat session with the user: it reads a ticket and its runs, fetches the status, the trace, the result and a deterministic diagnosis of a failed run, and, if it has the role and the scope, it dispatches a published workflow and polls it to completion. No dashboard, no reading logs by hand, no copying secrets.

## Current state (verified, not assumed)

Codex delivered 9 commits, 53 files, +12 499 lines. Local verification: `vitest run src/mcp src/db/mcp-foundation-migration.test.ts src/db/auth-schema.test.ts env.test.ts src/auth.test.ts` → **18 files, 171 tests, exit 0**.

Done and green:

- MCP configuration in `env.ts` (the `z.enum(["true","false"]).transform(...)` pattern, consistent with the repo);
- the migration with the tables `mcp_audit_events`, `mcp_idempotency_keys`, `mcp_rate_limit_windows`, `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`;
- Better Auth as the OAuth Authorization Server (`@better-auth/oauth-provider@1.6.20`, the peer `better-auth ^1.6.20` satisfied by the installed `1.6.20`), DCR rejected by default;
- login and consent pages under `/mcp-auth/*` plus RFC 9728 metadata and forwarding discovery: **this goes beyond Codex's plan, the plan did not anticipate it**;
- `McpActorContext`, `policy.ts`, `audit-store.ts`, `idempotency-store.ts`, `rate-limit-store.ts`, `sanitize-result.ts`, `execute-tool.ts`;
- stateless Streamable HTTP: `POST /mcp` works, `GET`/`DELETE` return 405, the body is read as a stream with a hard limit.

`McpToolDependencies` already has `db`, `adapters`, `actor`, `requestId`, `traceId`, `now`, and `transport.ts:105-111` builds them through `createAdapters()`. The dependency contract is frozen and needs no changes.

`contracts.ts:7` (`FIRST_SLICE_TOOLS`) and `policy.ts:53` declare the full set of nine tools of the slice, but `server.ts` registers **only** `system.capabilities`. All the remaining scope is filling in an already frozen contract.

Missing: `mcp/tools/*`, `mcp/run-diagnosis.ts`, `mcp/tool-catalog.ts`, `mcp/contracts/mcp-contract.json`, `scripts/generate-mcp-contract.ts`, `scripts/mcp-smoke.ts`, `routes/api/v1/system/mcp-readiness.get.ts`.

## User stories

1. As a developer I want to connect `/mcp` in Claude Code and go through login in the browser, so that the agent acts on my behalf, with my role and only with the permissions I consented to.
2. As a developer I want to ask the agent for a ticket and its runs, so that I do not have to look them up by hand in Jira and the dashboard.
3. As a developer I want the agent to fetch the status, the trace and the result of a specific run, so that it diagnoses a failure without my involvement.
4. As a developer I want a deterministic classification of the failure cause, so that the agent does not guess and so that the same failure is always named the same way.
5. As an administrator I want to dispatch a published workflow through the agent, after a preflight, so that I do not have to enter the dashboard.
6. As an administrator I want a repeat of the same dispatch not to start a second run, even when the first response never reached me.
7. As an administrator I want a member to be able to read but not to dispatch, and I want a missing scope to be distinguishable from a missing role.
8. As an operator I want to see every call in the audit, including a rejected one, so that I know who tried what.
9. As an operator I want no response and no log to contain secrets or content that could steer the agent.
10. As an operator I want to turn `/mcp` off with a single variable, with no impact on `/api/v1`, the webhooks and the cron.

## Implementation decisions

**Tool registration.** Each `mcp/tools/<domain>.ts` file exports `register<Domain>Tools(server, deps)`. `server.ts` calls those functions. That way the tool-writing stages have completely disjoint files, and `server.ts` is touched once, in the wiring stage. Each domain's tests build their own `McpServer`, register only their own tools and call them through the SDK.

**Every tool goes through `executeMcpRead` or `executeMcpMutation`.** A handler never calls the adapters or the database directly outside `operation`. That is the only place where authorization, rate limiting, audit, idempotency, timeout and redaction live. A second path is a violation of this plan.

**Trust.** `sanitize()` in `execute-tool.ts` marks data as `external_untrusted` by default. A tool whose result comes exclusively from deployment configuration overwrites `envelope.meta.trust` after the fact, the way `system.capabilities` does today.

**Run terminality has one definition, and it includes `awaiting`.** The repo is inconsistent: `run-detail-read.ts:23` counts `awaiting` as terminal, `run-observability/store.ts:309-313` does not. MCP picks the `run-detail-read` variant, because `awaiting` means the run is waiting for a human, so the agent should stop polling instead of spinning in a loop until the timeout. This is settled by a single exported function `isTerminalRunStatus` in `contracts.ts`, frozen in stage `A4`, so that `tickets.list_runs` and `runs.get` do not answer that question independently.

**A missing replay is a state, not an absence.** `getRunReplay` never returns `null`: it returns `availability` in the variants `not_captured`, `expired` or `available`, and for the others it returns empty `attempts` and `snapshot: null` (`run-observability/store.ts:966-1024`). `runs.trace` passes that variant through instead of pretending the run has no events. Worth knowing: the organization check in that module lets through runs with `organizationId = NULL` (`store.ts:930`), which is one more confirmation of Assumption 1.

**The diagnosis is a pure function.** `run-diagnosis.ts` does not touch the database or the adapters and runs no LLM. The frozen contract:

```ts
export type RunDiagnosisCategory =
  | "succeeded" | "running" | "awaiting_input" | "cancelled"
  | "never_started" | "no_workflow_matched" | "stopped_without_reason"
  | "dependency_auth" | "dependency_unavailable"
  | "sandbox_timeout" | "workspace_unavailable" | "workspace_gate"
  | "validation_failed" | "budget_exhausted" | "engine_error"
  | "step_failed"
  | "unknown";

export type RunDiagnosis = {
  category: RunDiagnosisCategory;
  confidence: "high" | "low";
  evidenceRefs: string[];   // stable references to attemptId/blockId, never content
  nextActions: string[];    // a fixed list of phrases, not generated text
};

export function diagnoseRun(input: {
  status: "success" | "running" | "failed" | "blocked" | "awaiting";
  error: { code?: string; message?: string } | null;
  steps: ReadonlyArray<{
    stepId: string;
    name: string;
    status: string;
    error?: { code?: string; message?: string } | null;
  }>;
}): RunDiagnosis;
```

The signature deliberately repeats the shape that `RunDetail`/`RunStep` actually return (`apps/shared/contracts/domain.ts:162-179`), so that stage `B2` does not have to build a lossy adapter.

The rules are ordered, the first match wins, and no match yields `unknown` with `confidence: "low"`. It never returns log content.

Two findings from the implementation changed this contract. First, `RunError.code` in this system **is not a taxonomy of causes**, only a correlation identifier `AIW-DIAG-` (`lib/overview/sanitize-run-detail.ts:60-68`), so no causal category may get `confidence: "high"` out of an error code. High confidence comes exclusively from structural signals: the run status and the step status. Rules based on message content anchor on `startsWith` against sentences generated by the system itself (`workflow-definition/failure-message.ts`, `interpreter.ts:88`), never on text that somebody from the outside can influence, and they always yield `confidence: "low"`. Second, the `awaiting_input` category was added: the original list did not have it at all, so a run parked waiting for a human fell into `unknown` with the action "inspect the trace by hand", which suggests a failure where the state is perfectly well known. It is at the same time the most common question an agent will ask about a stalled run.

**Two idempotency layers of the dispatch must agree.** `dispatchManualWorkflow` (`manual-dispatch/service.ts:94`) has its own idempotency: `requestId` plus `payloadHash`, the same hash returns the stored result, a different one gives a conflict. `executeMcpMutation` has its own, on `mcp_idempotency_keys`. Three things must be true at once, otherwise the layers drift apart:

1. **`requestId` is derived from the identity of the MCP lease, not from the raw key.** The MCP key expires after 24 h and is reclaimed, while the row in `manual_dispatch_requests` never expires. Deriving `requestId` from `(organizationId, actorSubject, clientId, tool, idempotencyKey)` alone means that after the key is reclaimed the agent gets `status: "started"` with a `runId` from a day ago, with no new run and no error. That is why the material is the `leaseId` issued by `beginMcpMutation`, which is new after every reclaim.
2. **Non-terminal results do not reach `completeMcpMutation`.** `dispatchManualWorkflow` legitimately returns `status: "recovering"` with no `runId` from at least six places (`service.ts:162, 321, 402, 428, 452, 465, 476`); the run only starts from the recovery cron. Persisting such a response freezes it for 24 h: the agent gets "it did not work" forever, while the run is working on its ticket. `recovering` releases the lease and comes back to the agent as a retryable result with `pollAfterMs`.
3. **Transient errors are not persisted as terminal, and a retry must get a new lease.** Verified in the code and contrary to the original assumption: `markManualDispatchFailed` sets the `manual_dispatch_requests` row to `failed` for **every** code, including `at_capacity` (`service.ts:296-312`), and `listRecoverableManualDispatches` filters on `pending|reserved|prepared|candidate_started` (`store.ts:236-251`), so the cron will never retry such a request. Conclusion: after a momentary lack of capacity that particular `requestId` is dead forever and the only way to retry is a **new** `requestId`. That makes point 1 not hygiene but a condition of the thing working at all: an MCP lease released after a transient error must issue a new `leaseId` on retry, because that is what `requestId` is derived from. If a retry got the same `leaseId`, the agent would be left with a key that will never start a run again. Only permanent codes are persisted as `failed` (validation, missing permissions, a stale version); `safeReplayMessage` (`idempotency-store.ts:59-72`) degrades a persisted error to a bare "Conflict" with `retryable: false` anyway.

Drift between these layers is the main risk of stage B3, and each of these three points has its own test.

**Correction after gate A2: `active_runs` is not a safeguard against a double dispatch.** I assumed that even if the MCP layer let a retry through, the subject reservation would stop it. It will not: `release()` deletes the row at the moment the run **finishes** (`adapters/run-registry/postgres.ts:400-413`), so it is a concurrency lock, not an idempotency one. The reproduced sequence: the dispatch starts, after 30 s the race returns `TIMEOUT` with the advice "retry with the same key", the invocation freezes, the run finishes at 200 s and releases the reservation, the agent retries at 301 s, the lease has already expired, the key is taken over and a second real run appears on the same ticket.

Two rules follow from this, and they replace the earlier ones:

- **The criterion for releasing the lease is not `retryable`, it is "do we know for sure that the effect did not land".** Releasing is allowed only for errors raised before the dispatch service could have started anything (`at_capacity`, `active_run`, `deployment_changed`, `invalid_input`, `not_eligible`). Every other case, including "I do not know", persists the lease. The price of getting it wrong in one direction is a second run on somebody else's ticket, in the other it is only the need to use a new key.
- **A timeout persists the lease as terminal instead of leaving it in the `started` state.** Otherwise, once the lease expires the row is takeable even though the dispatch may have started. The replayed terminal error is `retryable: false` and points to `runs.get` and to a new key, because retrying the same key will never change the state again, and promising progress gives a 24-hour livelock.

**The mutation lease expires sooner than the response.** Today a single `expiresAt` (24 h, `execute-tool.ts:21`) governs both the reclaiming of an abandoned lease and the lifetime of the response to be replayed. When the race with `MCP_TOOL_TIMEOUT_MS` (30 s) is lost, the row stays at `state = 'started'` while the invocation is already frozen, so `completeMcpMutation` will never run: that same ticket cannot be dispatched through MCP for a day. Those two times get separated: a lease with no progress is reclaimable after a few minutes, a persisted response still lives for 24 h.

**Preflight is binding.** `workflows.dispatch` accepts `preflightDigest` and `expectedDeployedVersion`. The digest is computed from the preflight result with a canonical hash. A version mismatch gives `CONFLICT`, not a silent dispatch against the new version.

**Pagination must not lie about completeness.** Two concrete ways it would lie, and what blocks them:

- `runs.trace` uses the existing cursor from `getRunReplay` (base64url), not its own. But when the byte limit is exceeded `sanitizeMcpData` replaces the whole `data` with `{ digest, truncated: true }` and **leaves a valid `nextCursor`** (`sanitize-result.ts:176-184`). The agent would then get an empty first page, follow the cursor and diagnose the run from a trace missing exactly the page that usually holds the first failed attempt, and with no way out on top of that, because the same cursor will always return the same oversized page. The page size is therefore derived from the byte budget, and payload bodies are trimmed before sanitization, so that a page never falls into the global truncation.
- `tickets.list_runs` wraps `listRunsForTicket`, which **has no LIMIT in SQL** and computes `totals` over the whole set (`runs-read.ts:616-631`). Truncating the array after the fact would produce an envelope in which `totals.runCount` says 63 while the array has 20 entries, with `truncated: false`, because that flag reacts only to the byte limit. The slice does not expose `totals` computed over a set wider than the returned page, the limit goes into the query, and the truncation information sits in `data`, not only in `meta`.

**Contract hash.** `MCP_CONTRACT_HASH` lives in `sanitize-result.ts` today. The contract stage moves its computation into `tool-catalog.ts`, over canonical JSON of the names, schemas and annotations, and `sanitize-result.ts` only re-exports it. The snapshot in `mcp/contracts/mcp-contract.json` is committed, and a test enforces that the generated contract is identical to it.

## Seams and testing decisions

| Seam | Observed behavior | Prior art |
|---|---|---|
| **S1: `POST /mcp` (external, topmost)** | the full client cycle: initialize, tools/list, tools/call, 401 with `WWW-Authenticate`, 405 on GET/DELETE, the envelope shape and redaction | `src/mcp/transport.test.ts` (already exists and passes), `src/db/test-db.ts:14` |
| **S2: `register<Domain>Tools(server, deps)` (internal)** | the role × scope × error code matrix and the mapping of domain errors onto public codes, with no transport | `src/mcp/execute-tool.test.ts`, `src/mcp/policy.test.ts` |
| **S3: existing services (reuse)** | that MCP does not duplicate domain rules; a fake adapter is substituted in the tests | `adapters/issue-tracker/types.ts:24` (fake in `jira.test.ts`), `manual-dispatch/service.ts:94` |

No new seams where the repo already has them. S3 is real, because the adapter has two implementations.

**Error codes extended with `TIMEOUT`.** The design spec (§7) lists a closed set without this code. I am extending it deliberately, because the point of the codes in the envelope is that the agent decides without reading prose, and a mutation cut off by a timeout requires a different action than an unavailable dependency: `DEPENDENCY_UNAVAILABLE` means "the backend is down, retry later", while the truth is "the dispatch is probably running right now, check the state". Returning the former would be the same mistake we are fixing for the failed mutation audit, only under a different name. `TIMEOUT` is retryable, its message says outright that the operation may already have landed, and the same code goes into the audit, so that the operator can tell "timeout, state unknown" from a failure to persist the result. The change lands before stage `C2`, that is, before the contract gets frozen in `mcp-contract.json`. The reach of this single value is **three files, not one**: `contracts.ts` (the union) plus two exhaustive switches, `transport.ts` (`statusFor`, where `TIMEOUT` maps to **504**, because 503 would collide with `DEPENDENCY_UNAVAILABLE` and erase the very distinction being added) and `idempotency-store.ts` (`safeReplayMessage`, a compile-only case, because the timeout path never persists a lease as failed).

## Out of scope

- Ticket mutations, workflow authoring, harness and memory. Those are separate increments with their own plan.
- `.github/actions/mcp-release-smoke` and wiring it into Arthur's release pipeline (Tasks 11-12 of Codex's plan). They land only after manual dogfooding.
- Deployment to `ai-workflow-app`, creating OAuth clients and dogfooding acceptance (Task 13). That is a human gate.
- `ai-workflow-demo`.
- Adding `organization_id` to `workflowRuns` and `workflowDefinitions`.

## Assumptions

1. **One deployment is one organization.** Only 5 of 34 tables have `organization_id`; `workflowRuns` and `workflowDefinitions` do not. `fetchRunDetailFromDb` filters on `runId` only (`run-detail-read.ts:98-103`), `listRunsForTicket` on `ticketKey` only (`runs-read.ts:616-620`), whereas `getRunReplay` **requires** a matching organization (`run-observability/store.ts:977-981`). Tenant isolation therefore rests exclusively on the actor gate in `request-context.ts:47`, and it is written down that way instead of pretending row-level isolation. The practical consequence the tools have to tell the truth about: `runs.trace` may return `not_captured` for a run that `runs.get` shows normally, because the replay is sometimes not pinned to an organization. This is a known limitation, not a bug to work around with a fake in a test.
2. **The branch is stale and needs a rebase; the migration gets the number 0047.** Verified against `origin/main` (`533b514f`, twelve commits ahead of the local `main`): the numbers `0044_workflow_run_prs_lookup`, `0045_schedule_occurrence_run_cancelled` and `0046_local_skill_source` are **already merged**. Renumbering the file alone is not enough, for two reasons. First, the MCP snapshot has a `prevId` pointing at `0043` and does not know the columns `source_kind`, `local_path`, `local_content_sha256` in `harness_skill_artifacts`; after the merge it would become the last one in the chain, so the next `db:generate` would generate a migration adding objects that already exist in production, and it would fail on `column already exists`. Second, the `when` of the MCP migration (`1786264177264`) is earlier than all three migrations from `main`, and the drizzle runner decides whether to apply a migration precisely by `when`, not by the file name and not by a hash of the contents. That is why the branch is first rebased onto `origin/main`, and the migration and its snapshot are **regenerated**, not renamed. The `RESERVED_0045_MIGRATION_WHEN` assert in `src/db/mcp-foundation-migration.test.ts:21,157` guards an ordering that no longer exists and goes away, but it **must be replaced** by real journal invariants, because it is the only place in the repo guarding the relative order of migrations (see Assumption 7).

   Correction after the pre-mortem: I originally wrote here that the regeneration also closes the matter of the `workflow_runs_prs_gin_idx` index. That was untrue. That index is in no snapshot, including the new `0047`, and not in `schema.ts` either; it lives exclusively in the hand-written `drizzle/0044_workflow_run_prs_lookup.sql:1`. The regeneration was right for the two reasons listed above, and not for this one. The trap stays open and is described in Assumption 8.
3. **The recommendation "one idempotency instead of two" has been overtaken by facts.** `mcp_idempotency_keys` is already built, tested and green. Reverting that would be a destructive rework, so it stays, and the risk moves onto the deterministic derivation of `requestId` described above.
4. **Audit: the `attempted` row is always fail-closed, fail-open applies only to writing the result.** The original recommendation ("whole reads fail-open") was too broad and created a hole: `writeMcpAudit` fires `pruneMcpAudits` on **every** write (`audit-store.ts:17,21`), and a bare `occurred_at < cutoff` does not hit the `mcp_audit_events_organization_occurred_at_idx` index (`0044_mcp_foundation.sql:135`). On a large table the prune degrades into a scan and starts timing out, so fail-open across the board would mean that past a certain size **every** read goes through without a trace, and a limit of 120 reads per minute is enough to push an instance into that regime and enumerate tickets and runs invisibly. Therefore: the pre-authorization `attempted` row is fail-closed for reads as well (it is the only record proving an attempt was made), fail-open applies only to writing the result and bumps the `mcp_audit_write_failed` counter, and the prune moves out of the request path into the cron.
5. **OAuth clients on the internal deployment already exist** (confirmed by the user), so the Task 13 gate does not start from zero.
6. New code does not use `db.transaction()` (neon-http has no transactions) and does not import Node modules outside the body of `"use step"`.

7. **Migration ordering has no gate anywhere in the repo, and this is broader than MCP.** The drizzle runner applies a migration when the `when` from the journal exceeds the database watermark, whereas `src/db/test-db.ts:17-19` applies files sorted by name and never reads the journal. The drift is silent: a migration with a `when` lower than the watermark is skipped in production with no log, while in the tests it is present, so the build is green and only the runtime returns a 500 on the missing object. Reproduced on PGlite in the pre-mortem. Stage `A0` replaces the removed assert with a test guarding three journal invariants: strictly increasing `when`, the journal order matching the lexical order of the file names, and the entry count matching the file count.

8. **A known trap inherited from `origin/main`, deliberately left open.** The `workflow_runs_prs_gin_idx` index exists only in the hand-written migration `drizzle/0044_workflow_run_prs_lookup.sql:1` and is invisible to drizzle: it is neither in `schema.ts` nor in any snapshot. The day someone adds it to `schema.ts`, `db:generate` will produce a `CREATE INDEX` and `pnpm build` will fail on `already exists` on every database that has seen `0044`. This is not a problem introduced by MCP and fixing it does not belong to this slice, but it is recorded here so that nobody discovers it a second time.

9. **Local development databases that ran this branch before the renumbering need manual cleanup.** The MCP migration changed its `when`, and drizzle recognizes migrations by that field only, so such a database will try to apply `0047` a second time and fail on `CREATE TABLE "mcp_audit_events"`. Production, customer deployments and Arthur's snapshot are safe, because their watermark is at most `0046` and the branch never reached `origin`. Fixing a local database means deleting the stale row from `drizzle.__drizzle_migrations`.

## Stages

Gates A and C are sequential. The B fan-out starts only after gate A is green and has fully disjoint files.

| # | Stage | Seam | File scope | Tier | Skeptic | TDD | Delegation | DoD |
|---|------|------|---------------|------|---------|-----|-----------|-----|
| A0 | Commit the transport WIP, rebase onto `origin/main`, regenerate the migration as `0047` | - | the whole branch (rebase), `apps/worker/drizzle/*`, `drizzle/meta/*`, `src/db/mcp-foundation-migration.test.ts`, `src/db/schema.ts` (conflict resolution), `src/mcp/transport.ts`, `src/mcp/transport.test.ts` | opus | yes | no | no | `git log --oneline origin/main..HEAD` shows **exactly 11 commits**: two docs ones and nine MCP ones; `ls drizzle/00*.sql` ends at `0047_mcp_foundation.sql`; `pnpm --filter worker exec drizzle-kit generate` **produces no new migration** (proof that the snapshot matches `schema.ts`); `vitest run src/db/mcp-foundation-migration.test.ts src/db/auth-schema.test.ts src/mcp/transport.test.ts` green; `git status` clean |
| A1 | Audit of rejected calls, fail-open only on the result, prune out of the request path | S2 | `src/mcp/execute-tool.ts`, `src/mcp/execute-tool.test.ts`, `src/mcp/audit-store.ts`, `src/mcp/audit-store.test.ts`, `src/routes/cron/poll.get.ts` | opus | yes | yes | no | `vitest run src/mcp/execute-tool.test.ts src/mcp/audit-store.test.ts` green; `FORBIDDEN`, `INSUFFICIENT_SCOPE` and `RATE_LIMITED` leave an audit row; a failed `attempted` write blocks a read as well; a failed result write on a read returns the data and bumps the counter; `writeMcpAudit` does not call the prune |
| A2 | Separating the lease time from the response lifetime | S2 | `src/mcp/idempotency-store.ts`, `src/mcp/idempotency-store.test.ts` | opus | yes | yes | no | `vitest run src/mcp/idempotency-store.test.ts` green; a lease abandoned after a tool timeout is reclaimable in minutes, not after 24 h; a lease released after a transient error issues a **new** `leaseId` on retry; a persisted response is still replayable for 24 h; a concurrent duplicate still gets `CONFLICT`; `mcp_idempotency_keys` gets a retention sweep wired into the cron, because today every new key stays in the table forever |
| A3 | Deterministic diagnosis classifier | S2 | `src/mcp/run-diagnosis.ts`, `src/mcp/run-diagnosis.test.ts` | sonnet | yes | yes | no | `vitest run src/mcp/run-diagnosis.test.ts` green; covered: dependency auth, sandbox timeout, validation failed, workspace gate, cancelled, no evidence → `unknown`/`low` |
| A4 | Shared test fixtures and the run summary type | S2 | `src/mcp/test-support.ts`, `src/mcp/contracts.ts` | sonnet | no | no | no | `vitest run src/mcp` green; `actorFor`/`depsFor` have a single source; `McpRunSummary` exported from `contracts.ts` |
| B1 | Ticket tools | S2, S3 | `src/mcp/tools/tickets.ts`, `src/mcp/tools/tickets.test.ts` | sonnet | yes | yes | no | `vitest run src/mcp/tools/tickets.test.ts` green; `tickets.get` marks the data as `external_untrusted`, a ticket with an injected instruction stays data, `IssueTrackerNotFoundError` → `NOT_FOUND`; `tickets.list_runs` has the limit in the query, does not expose `totals` wider than the returned page and signals truncation in `data` |
| B2 | Run tools: status, trace, result, diagnosis | S2, S3 | `src/mcp/tools/runs.ts`, `src/mcp/tools/runs.test.ts` | sonnet | yes | yes | yes | `vitest run src/mcp/tools/runs.test.ts` green; a trace page fits in the byte budget, so it never falls into the global truncation that leaves the cursor alone; a non-terminal run does not pretend to have a result; secrets redacted; a run with no pinned replay returns an explicit `not_captured` rather than an empty list pretending there are no events |
| B3 | Preflight and idempotent dispatch | S2, S3 | `src/mcp/tools/workflows.ts`, `src/mcp/tools/workflows.test.ts` | opus | yes | yes | no | `vitest run src/mcp/tools/workflows.test.ts` green; two identical dispatches give the same `runId` and exactly one service call; a different payload on the same key → `IDEMPOTENCY_CONFLICT`; a stale `expectedDeployedVersion` → `CONFLICT`; member → `FORBIDDEN`; `recovering` is not persisted and comes back as retryable with `pollAfterMs` (**SUPERSEDED**: `recovering` persists the lease and is non-retryable, see correction 2 in the corrections chapter); `at_capacity` does not get frozen as a permanent failure; reclaiming the key after 24 h gives a new `requestId`, not yesterday's `runId` |
| C0 | The gate at the transport level, before entering the tool | S1 | `src/mcp/transport.ts`, `src/mcp/transport.test.ts` | opus | yes | yes | no | `vitest run src/mcp/transport.test.ts` green; a `tools/call` with a nonexistent tool name and with arguments that do not match the schema consumes the rate limit budget and leaves a trace, instead of passing for free; the cost of verifying the actor is not paid in full for rejected traffic |
| C1 | Tool registration and an integration test through `/mcp` | S1 | `src/mcp/server.ts`, `src/mcp/server.test.ts` | opus | yes | yes | no | `vitest run src/mcp/server.test.ts src/mcp/transport.test.ts` green; `tools/list` returns the full set of nine names from `contracts.ts`; every tool's annotations match `policy.ts` |
| C2 | The contract artifact and the readiness endpoint | S1 | `src/mcp/tool-catalog.ts`, `src/mcp/tool-catalog.test.ts`, `src/mcp/contracts/mcp-contract.json`, `scripts/generate-mcp-contract.ts`, `src/routes/api/v1/system/mcp-readiness.get.ts`, `src/routes/api/v1/system/mcp-readiness.test.ts`, `apps/worker/package.json` | sonnet | no | yes | no | `pnpm --filter worker mcp:contract:check` exit 0; `vitest run src/mcp/tool-catalog.test.ts src/routes/api/v1/system/mcp-readiness.test.ts` green; the hash in `system.capabilities`, in the snapshot and in readiness identical; readiness does not reveal secrets |
| C3 | Smoke client over real HTTP | S1 | `apps/worker/scripts/mcp-smoke.ts`, `apps/worker/scripts/mcp-smoke.test.ts` | sonnet | no | no | no | `vitest run scripts/mcp-smoke.test.ts` green; the script uses an MCP client over HTTP and does not import the server; negative paths (wrong audience, expired token) covered with a fake; prints JSON evidence with no tokens |
| D | CI gate | - | no changes | - | no | no | no | push the branch; `ci.yml` green (`typecheck`, `test`, `test:release-notes`, `test:workflow-sdk`) |

**Stage A0 in detail.** The order of operations is binding, because a rebase on a dirty tree either refuses to start or autostashes itself into a conflict:

1. Commit the uncommitted changes in `transport.ts` and `transport.test.ts` (streaming body read with a limit, draining, JSON-RPC code `-32700`). That is finished and tested work, not WIP to throw away.
2. `git rebase --onto origin/main fb55629b feat/ai-workflow-remote-mcp`. That range deliberately **cuts off the two AIW-223 commits** (`9dda9dea`, `fb55629b`), which have nothing to do with MCP and live on in `feat/schedule-cron-trigger`. Nothing is lost, and the MCP PR stays clean. An interactive rebase is unavailable in this environment, so `--onto` with an explicit range is the only correct form.
3. Delete `0044_mcp_foundation.sql` together with its snapshot and its journal entry, and then **generate the migration from scratch** off the post-merge `schema.ts`. Regeneration, not renaming: the point is for the snapshot to know the columns `source_kind`, `local_path`, `local_content_sha256` and the index `workflow_runs_prs_gin_idx`.
4. Remove the `RESERVED_0045_MIGRATION_WHEN` assert (`src/db/mcp-foundation-migration.test.ts:21,157`), which guards an ordering that no longer exists, and repoint the test at the new number.

**Ordering.** `A0` → `A4` → (`A1`, `A2`, `A3` in parallel) → (`B1`, `B2`, `B3` in parallel) → `C1` → (`C2`, `C3` in parallel) → `D`.

`A2` runs in parallel with `A1` under one condition only: it implements the whole expired-lease reclaim logic **inside** `idempotency-store.ts`, using the `now` it already receives, and without changing the `beginMcpMutation` signature. `expiresAt` is computed today on the caller side (`execute-tool.ts:195`), that is, in a file belonging to `A1`; dragging a new parameter across that boundary is a conflict. If the `A2` executor decides it cannot be done without changing the signature, `A2` stops being parallel and goes after `A1`. `A4` goes before `A1`, because it extracts the fixtures out of `execute-tool.test.ts`, which `A1` then changes; the reverse order is a conflict on the same file. The `B` fan-out starts only after the whole `A` gate, because all three `B` stages rely on the shared fixtures from `A4` and on the corrected lease semantics from `A2`.

After stage D the work is code-complete. Task 13 of Codex's plan (deployment to `ai-workflow-app`, turning on `MCP_ENABLED`, dogfooding on live customers) is a **human gate** and does not belong to this orchestration.

## Pre-mortem

The skeptic (opus, fresh context, access to the code) reported ten findings and issued a REJECT for the original version of the plan. Resolutions:

| # | Finding | Outcome |
|---|---|---|
| 1 | `0046` is already taken on `origin/main`; the free number is `0047` | Verified separately and confirmed. Plan corrected: stage `A0`, Assumption 2 |
| 2 | After the merge, the MCP snapshot would revert the changes from three merged migrations | Plan fix: regenerate the snapshot after the rebase instead of renaming, with proof in the `A0` DoD |
| 3 | Non-terminal `recovering` persisted for 24 h | Plan fix: an implementation decision and the `B3` DoD |
| 4 | The idempotency key deadlocked for 24 h after a timeout | Plan fix: new stage `A2` |
| 5 | TTL drift returns yesterday's `runId` | Plan fix: `requestId` derived from `leaseId`, `B3` DoD |
| 6 | Prune in the request path plus fail-open is a hole in the audit | Plan fix: Assumption 4 narrowed, prune moved to the cron, `A1` |
| 7 | The DoD "somebody else's run looks like `NOT_FOUND`" is not achievable | Struck out as dishonest. The limitation is written down explicitly in Assumption 1, the `B2` DoD talks about `not_captured` |
| 8 | A truncated trace page leaves a valid cursor | Plan fix: page size from the byte budget, `B2` DoD |
| 9 | `tickets.list_runs` lies through `totals` over the full set | Plan fix: limit in the query, no wider `totals`, `B1` DoD |
| 10 | The fan-out is disjoint by file, but not by fixture | Plan fix: new stage `A4` before the gate |

No finding was rejected.

## Verification

Full suites run on CI only. Locally each stage runs only its own narrow test files listed in the DoD, plus `pnpm --filter worker typecheck`. The executors work in isolated copies of the tree: mutating one worktree in parallel corrupts other people's test results.

## Execution corrections from 2026-08-12 (this chapter overrides everything above)

The resolutions below were reached during execution and they **change the content of the sections above**. The stage ordering, the file scopes and two DoDs are different from what is written above. If you read this document without this chapter you will draw wrong conclusions.

### Stage ordering: the tool catalog lands before registration

Originally `C2` was to build the catalog for the sake of the contract hash. It turned out that three stages need the catalog independently: the `C0` gate (to validate arguments against the real schemas), `C1` (registration) and `C2` (the hash). The schemas lived as private constants inside the tool modules, so without the catalog the `C0` gate could only check the structure of the arguments, which left the main class of probing open: `system.capabilities` has `z.object({}).strict()`, so `{"extra":1}` bounced off the SDK **for free**, on the only tool registered at that point. Rejected alternative: a probe detecting after the fact that the execution funnel was never touched (it accounts after the response has been sent, so it will never return a 429 for this class, that is, it closes the symptom, not the hole).

New ordering: `B3` -> `C0` (catalog plus gate) -> `C1` (registering the full set from the catalog) -> `C2` (hash over the catalog plus readiness) -> `D0` -> `D`. `C3` runs independently.

`C0` therefore has a wider scope than its row in the table: `tool-catalog.ts`, `tool-catalog.test.ts`, `transport.ts`, `transport.test.ts`, moving the schemas out of `tools/tickets.ts` and `tools/runs.ts`, two new exports in `contracts.ts` (`MCP_UNRECOGNIZED_TOOL`, `McpAuditToolName`) plus rearranging `McpAuditInput.toolName`, and a widened `toolName` type in `rate-limit-store.ts`. `C2` **extends** the existing catalog and its test, it does not create them from scratch.

### Four decisions about the transport gate

1. **The response shape for the client does not change:** it stays a 200 with `isError: true` in the shape the SDK produces, because the consumer is an LLM agent that fixes its own call by reading the error content as a result. A hard `-32602` would take that self-repair away from it in exchange for protocol purity. The only thing that changes the status is budget exhaustion (429, the existing `RATE_LIMITED` behavior).
2. **The `MCP_UNRECOGNIZED_TOOL` sentinel covers only names outside the catalog.** A known name with bad arguments charges its own tool's bucket and goes into the audit under its own name, because otherwise an agent that got the arguments wrong would burn the budget meant for catching enumeration, and the operator would lose the information about which tool was called incorrectly. All unrecognized names share ONE bucket, because `toolName` goes into the window key in `mcp_rate_limit_windows`, so bucketing by a client-supplied name would hand a fresh 120/min window to every made-up name. The window is per actor, not per organization (verified).
3. **Widening the type, not casting.** The audit records an attempt, and an attempt may name a tool that does not exist, so the type says so. Casting the sentinel to `McpToolName` would silently break every future exhaustive `switch`.
4. **The invariant "the cost of verifying the actor is not paid in full" applies to traffic from before authentication** (no token, broken JSON-RPC, no name). For authenticated traffic the actor is resolved in full, because an audit row with no identity is worthless to the operator, and the enumeration we are closing is the work of a client that has already gotten through authentication. `request-context.ts` stays untouched. The gate validates the name against the CATALOG, not `FIRST_SLICE_TOOLS`.

### Two corrections in the dispatch layer

1. **`preflight` does NOT accept `expectedDeployedVersion`** (a deviation from Task 8 of Codex's plan and spec §8.4, ratified). Preflight is the discovery step that supplies that version in the first place, so requiring it as input was a loop with no exit. The binding stays on the dispatch, where it is server-authoritative.
2. **`recovering` PERSISTS the lease and is non-retryable.** This reverses the decision from the "Two idempotency layers" section (point 2), which said to release it. The reason: `releaseMcpMutation` does a DELETE of the key row, so retrying with the same key gives a new nonce, a new `leaseId`, a new `requestId` and **a second row in `manual_dispatch_requests`**, while the first one is still being picked up by `listRecoverableManualDispatches` from the cron every minute, with no age limit and no attempt counter. The reproduced sequence with two runs: a Jira hiccup yields `recovering`, the cron starts R1, R1 fails within tens of seconds and releases the subject reservation, the agent retries after 60 s exactly as its message tells it to, and R2 appears on the same ticket. The more frequent variant: the retry hits its own orphaned reservation, gets `active_run` and the agent tells the user "somebody has already started a run", which is not true. The chosen side of the mistake follows the principle from this plan: the other side is only the need to use a new key.
3. **`at_capacity` still RELEASES the lease.** The asymmetry with `recovering` is deliberate and is decided by whether the dispatch row after a given error is alive (the cron will pick it up) or dead (`markManualDispatchFailed` sets `failed` for every code, and the cron will never retry such a request).
4. `requestId` derived from `leaseId` required passing the lease into the operation, which `executeMcpMutation` did not do. An authorized two-line change in `execute-tool.ts`: `operation: (leaseId: string) => Promise<T>` and `input.operation(decision.leaseId)`. `leaseFor()` was already injecting a fresh nonce on every issue, for exactly this case.

### Error codes do not reach the client from inside a tool

The SDK (`server/mcp.js:135-162`) catches the handler's exception and builds `createToolError(error.message)`, that is, the text alone, with no `code`, `retryable` and `retryAfterMs`. `writePublicError` in `transport.ts` puts those fields into `error.data`, but that applies only to errors from BEFORE the SDK. The claim that "the agent decides without reading prose, because the codes are in the envelope" was therefore unrealized for all nine tools. The symptom that gave it away: the dispatch tests read the mapped code from the audit row in the database, because the client cannot see it. The fix: one shared wrapper at tool registration in `C1`, not nine edits.

### The contract hash already had a drift the plan did not anticipate

`MCP_CONTRACT_HASH` was computed over a hand-written literal of ten error codes in `sanitize-result.ts:45`, which `TIMEOUT` never made it into, even though the `McpErrorCode` union has it. The hash therefore announced a contract that the server does not implement, and that same hash went into the audit and into `system.capabilities`. The "Error codes extended with TIMEOUT" section talks about three files, while the reach was four points. `C2` eliminates this class of bug: the list of codes gets a single runtime definition from which the type is derived, and the catalog stops being indexed through `satisfies` on a literal and becomes an exhaustive `Record<McpToolName, ...>`, so that a missing entry is a compile error.

### The user's decision on scope

The nine-tool contract stays **frozen**. We are not adding a tool for discovering workflows or triggers. A known limitation for the dogfooding gate: `workflows.dispatch_preflight` requires `definitionId` and `triggerNodeId`, and no tool in the frozen set supplies them. `system.capabilities` reports which domains this deployment has enabled, which after stage `C1` is `system`, `tickets`, `runs` and `workflows`, but it deliberately does not enumerate workflow definitions or trigger nodes, so an agent asked to "run the workflow on PROJ-1" has to get the identifiers from a human. A follow-up, not an expansion of AIW-239.

### Migration: 0048, not 0047

The `feat/trigger-rate-limit-investigate` branch also creates a migration 0047 and will probably land first. A new stage `D0` before the push: rebase onto the current `origin/main`, then **regenerate** the MCP migration onto the next free number. Renaming is not enough, for the same reason Assumption 7 describes: drizzle applies by the `when` field from the journal, so a file with a `when` lower than the database watermark is skipped in production with no log, while in the tests it is present, because `db/test-db.ts` sorts files by name and never reads the journal. Their migration must not be overwritten, and two 0047 entries must not be left behind.

### Stage C3: different files than written down

The plan wanted a test in `scripts/mcp-smoke.test.ts`. `vitest.config.ts:6` restricts `include` to `["src/**/*.test.ts", "*.test.ts"]`, so such a file would never run, and `apps/worker/scripts/` does not have a single test. The smoke logic lives in `src/mcp/smoke-client.ts` and is tested there, while `scripts/mcp-smoke.ts` is a thin CLI wrapper. `vitest.config.ts` untouched.

### Debt and follow-ups recorded deliberately

- **Reads do not enforce the timeout.** `executeMcpRead` hands the operation an `AbortSignal.timeout(...)`, but it does not do a `Promise.race`, and no read operation listens to the signal (`fetchRunDetailFromDb` and `getRunReplay` do not accept one). With a bogged-down database the call hangs until the function is killed, and the audit is left with an `attempted` row and no result row, which is the shape the rest of the module describes as suspicious. Applies to `B1` and `B2`.
- **`initialize`, `ping` and unknown methods are still free and unaudited**, and every such request goes through full actor verification (a token plus three database queries) with no counter. The gate charges `tools/call` and `tools/list`.
- **If anyone ever started filtering `tools/list` by policy, the gate would silently recreate a full oracle of the surface**, including `workflows.dispatch` for the `member` role, because the distinction between "there is no such tool" and "the arguments are wrong" is explicit in the messages. Today this is not a leak only because `tools/list` hands everyone the full list anyway.
- **Three rate limit and audit rules exist in two places** (choosing the limit by mutation class, the first-refusal-in-window rule, `signalAuditWriteFailure` copied verbatim): `transport.ts` and `execute-tool.ts`. A change on one side will not fail a test on the other.
- **The gate in `transport.ts` is a patchwork**, the file grew from 250 to over 550 lines and now holds the HTTP framing, protocol negotiation, authorization, rate limiting, audit and zod error formatting. The natural boundary is `src/mcp/gate.ts`.
- **Two legitimate shapes of `rejected` with no `attempted`** (the throttle and a rejection in the gate), against the comment at `execute-tool.ts:174-177` claiming there is one. An operator alert built on that comment would give a false positive on every argument mistake an agent makes.
- **`not_captured` from `runs.trace` collapses four different realities** (the capture never started, the capture failed, the replay belongs to another organization, the run does not exist). Separating them requires a reason from `run-observability/store.ts`.
- **`evidenceRefs` from `runs.diagnose` live in a different namespace than the samples from `runs.trace`** (`phase:${name}` or a `stepId` from WDK versus `nodeId`, `id`, `diagnosticId`), while `nextActions` tells the agent to look for the step in the trace. Fixing it requires a shared identifier space.

Two more found by the full-surface test in `src/mcp/surface-e2e.test.ts`, both pinned there with a `KNOWN:` comment so they cannot regress silently:

- **An ungated request still builds the whole tool server and its adapters.** `initialize` and `notifications/initialized` are neither `tools/call` nor `tools/list`, so the gate returns null and the handler falls through to `createMcpServer({ adapters: createAdapters(), ... })`. `createAdapters` therefore runs twice per handshake, registering nine tools and constructing the issue tracker, messaging and run registry, for requests that can never reach a handler. Harmless today (no I/O on construction, `vcs` sits behind a lazy getter), but it is work done for traffic that is charged to no budget and written to no audit row, so it belongs with the unmetered `initialize` item above.
- **`RATE_LIMITED` reaches the agent in two shapes depending on where the charge happened.** Throttling a recognised tool is charged inside `execute-tool.ts`, so it comes back as a 200 tool result the agent can read. Throttling a name this server does not serve is charged in the gate, which THROWS, so it leaves through `writePublicError` as a JSON-RPC error with 429 and an SDK client raises it as a transport exception. The code and `retryAfterMs` are still on the wire in `error.data`, but the agent meets them as an exception rather than a result. The comment above `writeToolError` now states this carve-out instead of promising one shape. Unifying it would mean returning the throttle refusal instead of throwing, which drops the 429 status, so it is a deliberate open question rather than an oversight.
