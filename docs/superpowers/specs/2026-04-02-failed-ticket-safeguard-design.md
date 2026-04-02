# Failed Ticket Safeguard Design

## Problem

When a workflow fails and the catch block tries to move the ticket to backlog via Jira, that move can also fail (e.g., Jira outage, permission error, network timeout). When this happens:

1. The ticket remains in the AI column in Jira
2. The Redis run entry is preserved (by design — `unregisterRun` is skipped when move fails)
3. The WDK run is marked as `failed`
4. Reconciliation detects the `failed` run and unregisters it from Redis
5. Next poll cycle rediscovers the ticket in the AI column and dispatches it again
6. The workflow fails again for the same reason — **infinite loop**

## Solution

Add a "failed ticket" marker in Redis. Before dispatching a ticket, check if it's marked as failed. If so, skip it. The marker is cleared when the ticket leaves the AI column (detected by the existing reconciliation loop), meaning a human just needs to move the ticket out and back in to retry.

## Scope

The failure marker is **only** written when `moveTicket` to backlog fails in the workflow catch block. If `moveTicket` succeeds, the ticket is safely in backlog and won't be rediscovered by the poll — no marker needed.

## Redis Data Model

**Hash key:** `blazebot:failed-tickets:{ENV_PREFIX}`

Follows the same pattern as the existing `blazebot:active-runs:{ENV_PREFIX}` hash.

**Field:** Ticket key (e.g., `AWT-42`)

**Value:** JSON string with error context:

```json
{
  "runId": "run_abc123",
  "error": "Failed to move ticket to backlog: 403 Forbidden",
  "failedAt": "2026-04-02T12:34:56.000Z"
}
```

No TTL on the hash — entries are explicitly removed during reconciliation.

## Write Path — Marking Failures

In `src/workflows/implementation.ts`, the existing catch block is modified:

```typescript
catch (err) {
  const moved = await moveTicket(ticketId, env.COLUMN_BACKLOG)
    .then(() => true)
    .catch(() => false);
  if (moved) {
    await unregisterRun(ticket.identifier).catch(() => {});
  } else {
    await markTicketFailed(ticket.identifier, runId, err).catch(() => {});
  }
  throw err;
}
```

`markTicketFailed` writes to the `blazebot:failed-tickets` hash. It is `.catch(() => {})`-guarded because if even this Redis write fails, we still want to re-throw the original error. Reconciliation will eventually handle the stale run.

The same pattern is applied to `src/workflows/review-fix.ts` if it has an equivalent catch block.

## Read Path — Skipping Failed Tickets

In `src/lib/dispatch.ts`, before the atomic `claim` call:

```typescript
const isFailed = await runRegistry.isTicketFailed(ticketKey);
if (isFailed) {
  return { started: false, reason: "previously_failed" };
}
```

This is a single `hget` call before `claim`, avoiding wasted claim attempts on tickets known to be stuck. The `"previously_failed"` reason surfaces in poll response logs.

## Clear Path — Reconciliation Cleanup

In `src/lib/reconcile.ts`, after the existing reconciliation logic, iterate the `blazebot:failed-tickets` hash:

```typescript
const failedTickets = await runRegistry.listAllFailed();
for (const { ticketKey } of failedTickets) {
  if (!aiColumnTicketKeys.has(ticketKey)) {
    await runRegistry.clearFailedMark(ticketKey);
  }
}
```

When a ticket leaves the AI column (moved by a human), the next reconciliation pass removes the failure marker. If the ticket is later moved back to AI, it gets a fresh dispatch attempt.

## RunRegistryAdapter Interface Changes

Three new methods added to the existing interface in `src/adapters/run-registry/types.ts` (or wherever the interface is defined):

```typescript
interface RunRegistryAdapter {
  // ... existing methods (claim, register, getRunId, unregister, listAll) ...

  markFailed(ticketKey: string, meta: { runId: string; error: string; failedAt: string }): Promise<void>;
  isTicketFailed(ticketKey: string): Promise<boolean>;
  listAllFailed(): Promise<Array<{ ticketKey: string; meta: { runId: string; error: string; failedAt: string } }>>;
  clearFailedMark(ticketKey: string): Promise<void>;
}
```

## Upstash Implementation

In `src/adapters/run-registry/upstash.ts`:

| Method | Redis Operation |
|--------|----------------|
| `markFailed` | `hset("blazebot:failed-tickets:{ENV}", ticketKey, JSON.stringify(meta))` |
| `isTicketFailed` | `hget(...)` returns truthy/falsy |
| `listAllFailed` | `hgetall(...)` with JSON.parse on values |
| `clearFailedMark` | `hdel(...)` |

All follow the exact same Redis patterns already used for active-runs.

## Full Flow

1. **Workflow fails** — catch block tries `moveTicket` to backlog
2. **If move fails** — `markTicketFailed()` writes to `blazebot:failed-tickets` hash
3. **Next poll** — `dispatchDiscoveredTickets` calls `isTicketFailed()` — skips with `"previously_failed"`
4. **Human moves ticket out of AI column** — reconciliation calls `clearFailedMark()` — marker removed
5. **Human moves ticket back to AI** — dispatched fresh, no marker blocking it

## Testing

- Unit test: `markFailed` writes correct JSON to Redis hash
- Unit test: `isTicketFailed` returns `true` when marker exists, `false` when absent
- Unit test: `clearFailedMark` removes the entry
- Integration test: dispatch skips a ticket with a failure marker (returns `"previously_failed"`)
- Integration test: reconciliation clears failure marker when ticket leaves AI column
- Integration test: full loop — fail + move fails → marked → skipped → moved out → cleared → redispatched

## Files to Modify

| File | Change |
|------|--------|
| `src/adapters/run-registry/upstash.ts` | Add `markFailed`, `isTicketFailed`, `listAllFailed`, `clearFailedMark` |
| `src/adapters/run-registry/types.ts` | Extend `RunRegistryAdapter` interface |
| `src/workflows/implementation.ts` | Add `markTicketFailed` call in catch block |
| `src/workflows/review-fix.ts` | Same catch block change (if applicable) |
| `src/lib/dispatch.ts` | Add `isTicketFailed` check before `claim` |
| `src/lib/reconcile.ts` | Add failed-ticket cleanup pass |
| Tests for each of the above | New test cases |
