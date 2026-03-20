# Redis-Based Workflow Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate workflow runs for the same ticket using @upstash/redis, and cancel active runs when tickets are moved out of the AI column.

**Architecture:** A `RunRegistryAdapter` backed by an Upstash Redis hash (`blazebot:active-runs`) maps `ticketKey → runId`. The poll handler checks the registry before starting workflows and, after the start loop, reconciles the registry against the current AI column — cancelling and unregistering any runs whose tickets have left.

**Tech Stack:** @upstash/redis, vitest, Vercel Workflow `getRun(runId).cancel()`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/adapters/run-registry/types.ts` | `RunRegistryAdapter` interface |
| Create | `src/adapters/run-registry/upstash.ts` | Upstash Redis implementation |
| Create | `src/adapters/run-registry/upstash.test.ts` | Unit tests for the adapter |
| Modify | `env.ts` | Add `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` |
| Modify | `src/lib/adapters.ts` | Add `runRegistry` to `Adapters` |
| Modify | `src/lib/step-adapters.ts` | Add `runRegistry` to `StepAdapters` |
| Modify | `src/routes/cron/poll.get.ts` | Dedup check + stale-run cancellation |

---

### Task 1: Install @upstash/redis

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

```bash
pnpm add @upstash/redis
```

- [ ] **Step 2: Verify installation**

```bash
pnpm ls @upstash/redis
```

Expected: package listed with version

---

### Task 2: Add env vars for Upstash Redis

**Files:**
- Modify: `env.ts`

- [ ] **Step 1: Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to env.ts**

In the `server` object inside `createEnv`, add after the `CRON_SECRET` entry:

```typescript
// Redis (run registry)
UPSTASH_REDIS_REST_URL: z.string().url(),
UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
```

- [ ] **Step 2: Verify typecheck passes**

```bash
pnpm typecheck
```

Expected: no new errors (existing env usage unchanged)

---

### Task 3: Create RunRegistryAdapter interface

**Files:**
- Create: `src/adapters/run-registry/types.ts`

- [ ] **Step 1: Write the interface**

```typescript
export interface RunRegistryAdapter {
  /** Record that a workflow run is active for this ticket. */
  register(ticketKey: string, runId: string): Promise<void>;
  /** Get the runId for a ticket, or null if none registered. */
  getRunId(ticketKey: string): Promise<string | null>;
  /** Remove the ticket -> runId mapping. */
  unregister(ticketKey: string): Promise<void>;
  /** Get all tracked ticket -> runId pairs. */
  listAll(): Promise<Array<{ ticketKey: string; runId: string }>>;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm typecheck
```

---

### Task 4: Implement UpstashRunRegistry (TDD)

**Files:**
- Create: `src/adapters/run-registry/upstash.test.ts`
- Create: `src/adapters/run-registry/upstash.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UpstashRunRegistry } from "./upstash.js";

const HASH_KEY = "blazebot:active-runs";

const mockRedis = {
  hset: vi.fn(),
  hget: vi.fn(),
  hdel: vi.fn(),
  hgetall: vi.fn(),
};

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => mockRedis),
}));

function createRegistry() {
  return new UpstashRunRegistry({
    url: "https://fake.upstash.io",
    token: "fake-token",
  });
}

describe("UpstashRunRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("register", () => {
    it("stores ticketKey -> runId in the hash", async () => {
      const registry = createRegistry();
      await registry.register("PROJ-1", "run_abc");
      expect(mockRedis.hset).toHaveBeenCalledWith(HASH_KEY, { "PROJ-1": "run_abc" });
    });
  });

  describe("getRunId", () => {
    it("returns runId when ticket is registered", async () => {
      mockRedis.hget.mockResolvedValueOnce("run_abc");
      const registry = createRegistry();
      const result = await registry.getRunId("PROJ-1");
      expect(result).toBe("run_abc");
      expect(mockRedis.hget).toHaveBeenCalledWith(HASH_KEY, "PROJ-1");
    });

    it("returns null when ticket is not registered", async () => {
      mockRedis.hget.mockResolvedValueOnce(null);
      const registry = createRegistry();
      const result = await registry.getRunId("PROJ-99");
      expect(result).toBeNull();
    });
  });

  describe("unregister", () => {
    it("removes the ticketKey from the hash", async () => {
      const registry = createRegistry();
      await registry.unregister("PROJ-1");
      expect(mockRedis.hdel).toHaveBeenCalledWith(HASH_KEY, "PROJ-1");
    });
  });

  describe("listAll", () => {
    it("returns all registered ticket -> runId pairs", async () => {
      mockRedis.hgetall.mockResolvedValueOnce({
        "PROJ-1": "run_abc",
        "PROJ-2": "run_def",
      });
      const registry = createRegistry();
      const result = await registry.listAll();
      expect(result).toEqual([
        { ticketKey: "PROJ-1", runId: "run_abc" },
        { ticketKey: "PROJ-2", runId: "run_def" },
      ]);
    });

    it("returns empty array when no runs are registered", async () => {
      mockRedis.hgetall.mockResolvedValueOnce(null);
      const registry = createRegistry();
      const result = await registry.listAll();
      expect(result).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- src/adapters/run-registry/upstash.test.ts
```

Expected: FAIL — module `./upstash.js` not found

- [ ] **Step 3: Write the implementation**

```typescript
import { Redis } from "@upstash/redis";
import type { RunRegistryAdapter } from "./types.js";

const HASH_KEY = "blazebot:active-runs";

export class UpstashRunRegistry implements RunRegistryAdapter {
  private redis: Redis;

  constructor(opts: { url: string; token: string }) {
    this.redis = new Redis({ url: opts.url, token: opts.token });
  }

  async register(ticketKey: string, runId: string): Promise<void> {
    await this.redis.hset(HASH_KEY, { [ticketKey]: runId });
  }

  async getRunId(ticketKey: string): Promise<string | null> {
    return this.redis.hget<string>(HASH_KEY, ticketKey);
  }

  async unregister(ticketKey: string): Promise<void> {
    await this.redis.hdel(HASH_KEY, ticketKey);
  }

  async listAll(): Promise<Array<{ ticketKey: string; runId: string }>> {
    const all = await this.redis.hgetall<Record<string, string>>(HASH_KEY);
    if (!all) return [];
    return Object.entries(all).map(([ticketKey, runId]) => ({ ticketKey, runId }));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- src/adapters/run-registry/upstash.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/run-registry/
git commit -m "feat: add UpstashRunRegistry adapter for workflow dedup"
```

---

### Task 5: Wire RunRegistry into adapter factories

**Files:**
- Modify: `src/lib/adapters.ts`
- Modify: `src/lib/step-adapters.ts`

- [ ] **Step 1: Update `src/lib/adapters.ts`**

Add import:
```typescript
import { UpstashRunRegistry } from "../adapters/run-registry/upstash.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
```

Add `runRegistry` to the `Adapters` interface:
```typescript
export interface Adapters {
  issueTracker: IssueTrackerAdapter;
  vcs: VCSAdapter;
  messaging: MessagingAdapter;
  runRegistry: RunRegistryAdapter;
}
```

Add to `createAdapters()` return:
```typescript
runRegistry: new UpstashRunRegistry({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
}),
```

- [ ] **Step 2: Update `src/lib/step-adapters.ts`**

Add imports:
```typescript
import { UpstashRunRegistry } from "../adapters/run-registry/upstash.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
```

Add `runRegistry` to `StepAdapters` interface:
```typescript
export interface StepAdapters {
  issueTracker: IssueTrackerAdapter;
  vcs: VCSAdapter;
  messaging: MessagingAdapter;
  runRegistry: RunRegistryAdapter;
}
```

Add to `createStepAdapters()` return:
```typescript
runRegistry: new UpstashRunRegistry({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
}),
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/adapters.ts src/lib/step-adapters.ts
git commit -m "feat: wire RunRegistry into adapter factories"
```

---

### Task 6: Update poll handler — dedup + stale-run cancellation

**Files:**
- Modify: `src/routes/cron/poll.get.ts`

- [ ] **Step 1: Merge getRun into existing import and update destructure**

Merge `getRun` into the existing `start` import (line 2):
```typescript
import { start, getRun } from "workflow/api";
```

Update the destructure on the existing line:
```typescript
const { issueTracker, vcs, runRegistry } = createAdapters();
```

- [ ] **Step 2: Add dedup check inside the ticket loop**

At the top of the `for` loop body, *before* `fetchTicket(key)` (to avoid unnecessary Jira calls):

```typescript
// Skip if a workflow is already running for this ticket
const existingRunId = await runRegistry.getRunId(key);
if (existingRunId) {
  logger.info({ ticketKey: key, runId: existingRunId }, "poll_ticket_already_running");
  continue;
}
```

- [ ] **Step 3: Register runId after starting each workflow**

After each `start()` call, register the run. If `register` fails (Redis down), log a warning but don't block — the stale-run reconciliation will handle cleanup. Replace the two branches:

```typescript
if (existingPR) {
  const handle = await start(reviewFixWorkflow, [ticket.id, branchName]);
  await runRegistry.register(ticket.identifier, handle.runId).catch((err) =>
    logger.warn({ ticketKey: key, runId: handle.runId, error: (err as Error).message }, "poll_register_failed"),
  );
  logger.info(
    { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
    "workflow_started_review_fix",
  );
} else {
  const handle = await start(implementationWorkflow, [ticket.id]);
  await runRegistry.register(ticket.identifier, handle.runId).catch((err) =>
    logger.warn({ ticketKey: key, runId: handle.runId, error: (err as Error).message }, "poll_register_failed"),
  );
  logger.info(
    { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
    "workflow_started_implementation",
  );
}
```

- [ ] **Step 4: Add stale-run cancellation after the start loop**

After the `for` loop ends (after line 74), before the return statement, add.
Uses the already-fetched `ticketKeys` set (from the JQL query) to avoid redundant Jira API calls — any registered ticket NOT in that set has left the AI column:

```typescript
// Cancel runs for tickets that have been moved out of the AI column
const aiColumnSet = new Set(ticketKeys);
const activeRuns = await runRegistry.listAll();
let cancelled = 0;

for (const { ticketKey, runId } of activeRuns) {
  if (aiColumnSet.has(ticketKey)) continue; // still in AI column

  try {
    const run = getRun(runId);
    await run.cancel();
    await runRegistry.unregister(ticketKey);
    logger.info({ ticketKey, runId }, "poll_cancelled_stale_run");
    cancelled++;
  } catch (err) {
    // Run may already be finished — unregister to clean up
    await runRegistry.unregister(ticketKey).catch(() => {});
    logger.warn(
      { ticketKey, runId, error: (err as Error).message },
      "poll_stale_run_cleanup_error",
    );
  }
}
```

Update the return statement to include cancelled count:
```typescript
return { status: "ok", discovered: ticketKeys.length, started: started.length, cancelled };
```

- [ ] **Step 5: Verify typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 6: Run all tests**

```bash
pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/cron/poll.get.ts
git commit -m "feat: add dedup check and stale-run cancellation to poll handler"
```

---

### Task 7: Unregister runs on workflow completion

**Files:**
- Modify: `src/workflows/implementation.ts`
- Modify: `src/workflows/review-fix.ts`

Both workflows should unregister their ticket from the run registry when they complete (success or clarification), so that finished runs don't accumulate in Redis.

- [ ] **Step 1: Add unregister step function to `implementation.ts`**

Add a new step function:
```typescript
async function unregisterRun(ticketIdentifier: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  await runRegistry.unregister(ticketIdentifier);
}
```

- [ ] **Step 2: Call unregisterRun at every exit point in `implementationWorkflow`**

Add `await unregisterRun(ticket.identifier);` before every `return` AND before the `throw` at the end:

- Before `return` in the `implemented` branch
- Before `return` in the `clarification_needed` branch
- Before `throw new Error(...)` at the end (so error-path runs also get cleaned up)

Skip the early `if (!ticket) return;` — we don't have the identifier there and the stale-run reconciliation in poll handles that case.

- [ ] **Step 3: Add same unregister step to `review-fix.ts`**

Add the same `unregisterRun` step function. Call it:
- Before `return` in the `implemented` branch
- Before `throw new Error(...)` at the end

- [ ] **Step 4: Verify typecheck and run tests**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/implementation.ts src/workflows/review-fix.ts
git commit -m "feat: unregister runs from registry on workflow completion"
```
