# Polling Fallback for Missed Webhooks & Stuck Jobs — Design

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a periodic polling mechanism as a third layer of stale job protection. Catches two failure modes that webhooks alone cannot cover: (1) webhooks that Jira never fires, and (2) jobs that get stuck when containers die silently or workers crash mid-execution.

**Architecture:** A BullMQ repeatable job on a dedicated `maintenance` queue runs every `POLL_INTERVAL_MS`. Each tick performs two independent checks in parallel — a JQL search against Jira to discover missed tickets, and a DB query to detect stuck jobs past their timeout threshold.

**Limitation:** Polling is currently Jira-only. Linear support is not covered — the `searchTickets` JQL method has no Linear equivalent. When Linear is added as an issue tracker, a corresponding search method will be needed.

**Tech Stack:** BullMQ 5 (repeatable jobs), Jira REST API v3 (`/rest/api/3/search`), Drizzle ORM 0.45, Vitest 4, TypeScript 5.9 (strict ESM)

**Spec:** `docs/BLAZEBOT_SPEC.md` — Section 8.3 (extend with third layer)

---

## Context

The system currently relies entirely on Jira webhooks to trigger job dispatch. Two layers of stale job protection exist:

1. **Webhook-triggered cancellation** — contradicting webhook removes pending BullMQ jobs and tears down active containers
2. **Job-start verification** — both handlers fetch current ticket state and skip if no longer in AI column

Neither layer helps when a webhook simply never arrives (Jira outage, misconfigured hook, network drop) or when a job gets stuck (container OOM-killed, worker process crash, Docker daemon issue). The ticket sits in the AI column indefinitely with no recovery.

---

## Design

### Mechanism: BullMQ Repeatable Job

- New `maintenanceQueue` in `src/queue.ts` (separate from `ticket` queue)
- Single repeatable job added on service startup: `{ every: POLL_INTERVAL_MS }`
- Processed by a dedicated worker registered in `src/index.ts`
- Handler lives in new `src/poller.ts`

### Check 1: Missed Webhook Detection

1. Query Jira via `searchTickets(jql)` method — `status = "{COLUMN_AI}" AND project = {JIRA_PROJECT_KEY}`
   - **Note:** `searchTickets` returns only ticket keys (not full objects), so assignee data is unavailable without extra API calls
   - **Pagination:** `maxResults=50` is hardcoded in the Jira client. During outage recovery with >50 tickets in the AI column, excess tickets are picked up on subsequent poll cycles
2. Batch-fetch existing DB records for all returned ticket keys (single `WHERE externalId IN (...)` query) to avoid N+1
3. For each returned ticket ID, check against the batch result:
   - **Not in DB** → insert ticket record, enqueue `implementation` job
   - **In DB, `workflowState = failed`** → re-enqueue (same logic as retry-from-failed in router)
   - **In DB, already `queued`/`implementing`/`fixing_feedback`** → skip (already being handled)
4. Log `poll_ticket_discovered` for each newly enqueued ticket
5. `triggeredBy` — use `ticket.assignee` from DB for existing tickets, fall back to `"poller"` for new inserts (no extra Jira API call)

### Check 2: Stuck Job Detection

1. Query DB: `workflowState IN ('implementing', 'fixing_feedback') AND updatedAt < NOW() - STUCK_JOB_THRESHOLD_MS`
2. For each stuck ticket:
   - Look up `currentRunId` → find `containerId` from `runAttempts` → teardown container if alive (best-effort, swallow errors)
   - Mark run as `timed_out`
   - Check total attempt count against `JOB_MAX_RETRIES + 1` (total allowed attempts, not retries):
     - Under limit → re-enqueue the job (preserving job type: `review_fix` for `fixing_feedback`, `implementation` otherwise), log `stuck_job_recovered`
     - At limit → transition to `failed`, notify via messaging, log `stuck_job_exhausted`
3. Notify via messaging adapter on every stuck job detection (both recovery and exhaustion)

### Parallel Execution

Both checks are independent — run them with `Promise.allSettled([checkMissedWebhooks(), checkStuckJobs()])` so a slow Jira response doesn't delay stuck job detection. Create adapters once in `runMaintenancePoll()` and pass them to both functions.

### Race Conditions

A webhook and poller can discover the same ticket simultaneously. The DB lookup in the missed-webhook path provides protection: if the webhook handler already inserted the ticket, the poller finds it and skips. The race window is small (insert-to-select) and the worst case is a duplicate BullMQ job, which BullMQ deduplicates by `jobId` for new tickets.

---

## New Code

| File | Action | Responsibility |
|------|--------|---------------|
| `src/poller.ts` | Create | `runMaintenancePoll()` — orchestrates both checks |
| `src/poller.test.ts` | Create | Tests for missed webhook detection and stuck job recovery |
| `src/adapters/jira-client.ts` | Existing | `searchTickets(jql): Promise<string[]>` already implemented (`maxResults=50`, no pagination) |
| `src/adapters/jira-client.test.ts` | Existing | Tests for `searchTickets` already in place |
| `src/queue.ts` | Modify | Add `maintenanceQueue` with repeatable job config |
| `src/index.ts` | Modify | Register maintenance worker alongside ticket worker |
| `src/env.ts` | Modify | Add `POLL_INTERVAL_MS`, `STUCK_JOB_THRESHOLD_MS`, `JIRA_PROJECT_KEY` |
| `docs/BLAZEBOT_SPEC.md` | Modify | Extend Section 8.3 with third layer description |

---

## New Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `POLL_INTERVAL_MS` | `300000` (5 min) | How often the maintenance poll runs |
| `STUCK_JOB_THRESHOLD_MS` | `JOB_TIMEOUT_MS * 2` (20 min) | How long before a job is considered stuck |
| `JIRA_PROJECT_KEY` | (optional) | Jira project key for JQL queries (e.g., `PROJ`). When unset, missed-webhook detection is skipped — stuck job detection still runs. |

---

## Safety & Idempotency

- **New ticket dedup**: New ticket discovery uses deterministic `jobId` (`impl-{ticketId}-{dbId}`) — BullMQ deduplicates if the same ticket is discovered again before processing starts
- **Re-enqueue uses timestamped jobId**: Failed re-enqueues and stuck job recovery use `{prefix}-{ticketId}-{dbId}-{timestamp}` to ensure a fresh job is always created (intentionally non-deterministic — we *want* a new job here)
- **No double-processing**: If ticket is already `queued`/`implementing`/`fixing_feedback`, poller skips it
- **Respects retry limits**: Stuck job recovery counts against `JOB_MAX_RETRIES + 1` total attempts — won't retry forever
- **Jira errors are non-fatal**: If JQL search fails, log `poll_jira_error` and skip — next tick will retry. Stuck job detection still runs independently.
- **Single-instance safe**: BullMQ repeatable jobs are deduplicated by jobId, safe even with multiple service instances
- **Container teardown is best-effort**: If the container is already gone, the error is swallowed

---

## Verification

- [ ] Unit tests for `searchTickets` JQL method (mock HTTP, verify query construction) — already passing
- [ ] Unit tests for `runMaintenancePoll` — missed ticket discovery (new ticket, failed ticket re-enqueue)
- [ ] Unit tests for `runMaintenancePoll` — stuck job detection (container teardown, timed_out marking, re-enqueue)
- [ ] Unit tests for idempotency (poller skips tickets already `queued`/`implementing`/`fixing_feedback`)
- [ ] Unit tests for retry limit enforcement (`JOB_MAX_RETRIES + 1` attempts → transition to `failed`)
- [ ] Unit tests for `fixing_feedback` stuck tickets re-enqueued as `review_fix` (not `implementation`)
- [ ] Unit tests for graceful degradation (Jira error doesn't block stuck job detection, missing `JIRA_PROJECT_KEY` skips webhook check)
- [ ] Integration: start service, verify repeatable job appears in BullMQ dashboard/logs
- [ ] Manual: move a Jira ticket to AI column without webhook → verify poller picks it up within `POLL_INTERVAL_MS`
