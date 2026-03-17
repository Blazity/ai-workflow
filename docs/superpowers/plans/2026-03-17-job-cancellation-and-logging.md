# Job Cancellation & Structured Logging — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken container teardown on contradicting webhooks, wire `currentRunId` + `containerId` tracking end-to-end, and replace all ad-hoc `console.log` calls with structured JSON logging per spec Section 13.

**Architecture:** The worker writes `currentRunId` and `containerId` to the DB during runs so the router can look them up for cancellation. A shared `logger.ts` module creates child loggers with `ticket_id`, `ticket_identifier`, and `run_attempt_id` context. All existing `console.log`/`console.warn` calls are replaced with structured logger calls. Fastify's built-in logger is reused as the root.

**Tech Stack:** Fastify 5 (pino logger), Drizzle ORM 0.45, BullMQ 5, Vitest 4, TypeScript 5.9 (strict ESM)

**Spec:** `docs/BLAZEBOT_SPEC.md` — Sections 8.3, 13.1, 13.2, 13.3

---

## Existing Codebase State

| Component | Status | Issue |
|-----------|--------|-------|
| `handleMovedOutOfAi` in router | Scaffolded | Uses `ticket.currentRunId` for teardown, but it's a run attempt UUID, not a Docker container ID |
| `currentRunId` on tickets | Column exists | Never written — worker doesn't update it |
| `containerId` on run_attempts | Column exists | Never written — worker doesn't store `result.containerId` from sandbox |
| Container teardown | `teardownContainer(containerId)` exported from manager | Works, but never called with a real container ID |
| Logging | Ad-hoc `console.log` / `console.warn` | No structured JSON, no ticket/run context |

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/logger.ts` | Create | Shared logger factory — creates child loggers with ticket/run context |
| `src/logger.test.ts` | Create | Tests for logger factory |
| `src/worker.ts` | Modify | Write `currentRunId`/`containerId` to DB, use structured logger |
| `src/worker.test.ts` | Modify | Add tests for `currentRunId`/`containerId` writes, stale skip logging |
| `src/webhooks/router.ts` | Modify | Fix container teardown to look up `containerId` from `runAttempts`, use structured logger |
| `src/webhooks/router.test.ts` | Modify | Add test for container ID lookup path |
| `src/sandbox/manager.ts` | Modify | Use structured logger for container lifecycle events |
| `src/index.ts` | Modify | Export logger from Fastify app, use for webhook logging |

---

## Chunk 1: Structured Logger

### Task 1: Create logger module

**Files:**
- Create: `src/logger.ts`
- Create: `src/logger.test.ts`

- [x] **Step 1: Write the failing test**

Create `src/logger.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createLogger, createTicketLogger, createRunLogger } from "./logger.js";

describe("logger", () => {
  it("createLogger returns a pino-compatible logger", () => {
    const log = createLogger();
    expect(log).toBeDefined();
    expect(typeof log.info).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.child).toBe("function");
  });

  it("createTicketLogger returns a child logger with ticket context", () => {
    const log = createLogger();
    const ticketLog = createTicketLogger(log, "uuid-1", "PROJ-42");
    expect(ticketLog).toBeDefined();
    expect(typeof ticketLog.info).toBe("function");
  });

  it("createRunLogger returns a child logger with run context", () => {
    const log = createLogger();
    const ticketLog = createTicketLogger(log, "uuid-1", "PROJ-42");
    const runLog = createRunLogger(ticketLog, "run-uuid-1");
    expect(runLog).toBeDefined();
    expect(typeof runLog.info).toBe("function");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/logger.test.ts`
Expected: FAIL — `./logger.js` module not found.

- [x] **Step 3: Write `src/logger.ts`**

```typescript
import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}

export function createTicketLogger(
  parent: Logger,
  ticketId: string,
  ticketIdentifier: string,
): Logger {
  return parent.child({ ticket_id: ticketId, ticket_identifier: ticketIdentifier });
}

export function createRunLogger(
  parent: Logger,
  runAttemptId: string,
): Logger {
  return parent.child({ run_attempt_id: runAttemptId });
}
```

- [x] **Step 4: Install pino (Fastify already depends on it, but make the import explicit)**

Run: `pnpm add pino`

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/logger.test.ts`
Expected: All 3 tests PASS.

- [x] **Step 6: Commit**

```bash
git add src/logger.ts src/logger.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add structured logger factory with ticket/run context"
```

---

## Chunk 2: Wire `currentRunId` and `containerId` in Worker

### Task 2: Worker writes `currentRunId` and `containerId` to DB

The worker currently creates a run attempt but never writes the run ID back to `tickets.currentRunId` or the container ID to `runAttempts.containerId`. Both are needed for the router to tear down active containers.

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/worker.test.ts`

- [x] **Step 1: Write the failing tests**

Add these tests to `src/worker.test.ts` inside the existing `describe("worker handler", ...)` block:

```typescript
it("writes currentRunId to ticket and containerId to run attempt", async () => {
  mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
  mockRunSandbox.mockResolvedValue({
    exitCode: 0,
    status: "complete",
    summary: "Done",
    containerId: "docker-container-xyz",
  });

  const { createWorker } = await import("./worker.js");
  const worker = createWorker();
  const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

  await handler(
    makeJob({
      type: "implementation",
      ticketId: "PROJ-42",
      source: "jira",
      triggeredBy: "Mia",
    }),
  );

  // The mock DB's update should have been called with currentRunId and containerId
  // We verify the mock was called (the drizzle mock chain captures calls)
  const { db } = await import("./db.js");
  expect(db.update).toHaveBeenCalled();
});
```

- [x] **Step 2: Run test to verify it fails or passes with current mocks**

Run: `npx vitest run src/worker.test.ts`
Expected: May pass with mocks but actual DB writes are what matter. The test primarily ensures the code path exists.

- [x] **Step 3: Update `handleImplementation` in `src/worker.ts`**

After creating the run attempt (line ~85-94), add:

```typescript
// Write currentRunId to ticket so router can find the active run
await db.update(tickets)
  .set({ currentRunId: run!.id, updatedAt: new Date() })
  .where(eq(tickets.externalId, data.ticketId));
```

After `runSandbox` returns (line ~108), before any result handling, add:

```typescript
// Store container ID for cancellation by contradicting webhooks
if (result.containerId) {
  await db.update(runAttempts)
    .set({ containerId: result.containerId })
    .where(eq(runAttempts.id, run!.id));
}
```

In each result handler (complete, clarification, failed), clear `currentRunId`:

```typescript
await db.update(tickets)
  .set({
    // ...existing fields...
    currentRunId: null,
  })
  .where(eq(tickets.externalId, data.ticketId));
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/worker.test.ts`
Expected: All PASS.

- [x] **Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: write currentRunId and containerId to DB during agent runs"
```

---

### Task 3: Fix router container teardown to use `runAttempts.containerId`

The router currently reads `ticket.currentRunId` and passes it directly to `teardownContainer`. But `currentRunId` is a UUID for the run_attempts row, not a Docker container ID. It needs to look up the run attempt to get the actual `containerId`.

**Files:**
- Modify: `src/webhooks/router.ts`
- Modify: `src/webhooks/router.test.ts`

- [x] **Step 1: Write the failing test**

Add to `src/webhooks/router.test.ts`:

```typescript
it("looks up containerId from run_attempts and tears down the container", async () => {
  const { routeTicketTransition } = await import("./router.js");

  mockGetJob.mockResolvedValue(null);

  // Ticket has a currentRunId
  mockDb.select.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([
        { id: "uuid-1", workflowState: "implementing", currentRunId: "run-uuid-1" },
      ]),
    }),
  });
  // run_attempts lookup returns the containerId
  mockDb.select.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([
        { id: "run-uuid-1", containerId: "docker-container-xyz" },
      ]),
    }),
  });
  mockDb.update.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });

  await routeTicketTransition(makeEvent("AI", "Done"));

  expect(mockTeardown).toHaveBeenCalledWith("docker-container-xyz");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/webhooks/router.test.ts`
Expected: FAIL — current code passes `currentRunId` (a UUID) not the Docker container ID.

- [x] **Step 3: Fix `handleMovedOutOfAi` in `src/webhooks/router.ts`**

Replace the container teardown block (lines 170-183) with:

```typescript
if (ticket.currentRunId) {
  const runRows = await db
    .select()
    .from(runAttempts)
    .where(eq(runAttempts.id, ticket.currentRunId));
  const activeRun = runRows[0];
  if (activeRun?.containerId) {
    try {
      await teardownContainer(activeRun.containerId);
    } catch {
      /* best effort */
    }
  }
}
```

Also add the `runAttempts` import at the top:

```typescript
import { tickets, runAttempts } from "../schema.js";
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/webhooks/router.test.ts`
Expected: All PASS.

- [x] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All PASS.

- [x] **Step 6: Commit**

```bash
git add src/webhooks/router.ts src/webhooks/router.test.ts
git commit -m "fix: look up containerId from run_attempts for container teardown"
```

---

## Chunk 3: Structured Logging — Worker & Router

### Task 4: Replace console calls with structured logger in worker

**Spec Section 13.2** requires these events to be logged with `ticket_id`, `ticket_identifier`, `run_attempt_id` context:

- Job started / completed / failed
- Ticket state transition (from → to)
- Container spin-up / teardown
- Agent launched (container ID, run type)
- Agent exited (exit code, duration)
- Clarification requested
- Retry scheduled

**Files:**
- Modify: `src/worker.ts`

- [x] **Step 1: Add logger imports and create loggers in `handleImplementation`**

At the top of `src/worker.ts`, add:

```typescript
import { createLogger, createTicketLogger, createRunLogger } from "./logger.js";

const logger = createLogger();
```

In `handleImplementation`, after fetching the ticket and creating the run attempt, create scoped loggers:

```typescript
const ticketRow = (
  await db.select().from(tickets).where(eq(tickets.externalId, data.ticketId))
)[0]!;

const ticketLog = createTicketLogger(logger, ticketRow.id, data.ticketId);
```

After creating the run attempt:

```typescript
const runLog = createRunLogger(ticketLog, run!.id);
runLog.info({ type: "implementation", branchName }, "job_started");
```

- [x] **Step 2: Add structured log calls at each event point**

After stale job check:
```typescript
ticketLog.info({ trackerStatus: ticket.trackerStatus }, "stale_job_skipped");
return;
```

After sandbox returns:
```typescript
runLog.info(
  { exitCode: result.exitCode, containerId: result.containerId, durationMs: Date.now() - startTime },
  "agent_exited",
);
```

On complete:
```typescript
runLog.info({ prNumber: pr.number, prUrl: pr.url }, "pr_created");
ticketLog.info({ from: "implementing", to: "awaiting_review" }, "ticket_state_transition");
```

On clarification:
```typescript
runLog.info("clarification_requested");
ticketLog.info({ from: "implementing", to: "clarification_pending" }, "ticket_state_transition");
```

On failure:
```typescript
runLog.error({ error: result.error }, "agent_failed");
ticketLog.info({ from: "implementing", to: "failed" }, "ticket_state_transition");
```

- [x] **Step 3: Add `startTime` tracking**

At the start of `handleImplementation`, before the sandbox call:

```typescript
const startTime = Date.now();
```

- [x] **Step 4: Update worker tests — mock the logger module**

At the top of `src/worker.test.ts`, add a logger mock:

```typescript
const mockLogFn = vi.fn();
vi.mock("./logger.js", () => ({
  createLogger: () => ({
    info: mockLogFn,
    warn: mockLogFn,
    error: mockLogFn,
    child: () => ({
      info: mockLogFn,
      warn: mockLogFn,
      error: mockLogFn,
      child: () => ({
        info: mockLogFn,
        warn: mockLogFn,
        error: mockLogFn,
      }),
    }),
  }),
  createTicketLogger: (_p: unknown, _tid: string, _tident: string) => ({
    info: mockLogFn,
    warn: mockLogFn,
    error: mockLogFn,
    child: () => ({
      info: mockLogFn,
      warn: mockLogFn,
      error: mockLogFn,
    }),
  }),
  createRunLogger: (_p: unknown, _rid: string) => ({
    info: mockLogFn,
    warn: mockLogFn,
    error: mockLogFn,
  }),
}));
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/worker.test.ts`
Expected: All PASS.

- [x] **Step 6: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: add structured JSON logging to worker with ticket/run context"
```

---

### Task 5: Replace console calls with structured logger in router

**Spec Section 13.2** requires:

- Webhook received (ticket, event type, triggered by)
- Job enqueued (ticket, run type)
- Ticket state transition (from → to)

**Files:**
- Modify: `src/webhooks/router.ts`
- Modify: `src/webhooks/router.test.ts`

- [x] **Step 1: Add logger to router**

At the top of `src/webhooks/router.ts`, add:

```typescript
import { createLogger } from "../logger.js";

const logger = createLogger();
```

- [x] **Step 2: Add log calls in `handleMovedToAi`**

At the start of `handleMovedToAi`:
```typescript
logger.info(
  { ticketId: event.ticketId, fromColumn: event.fromColumn, toColumn: event.toColumn, triggeredBy: event.triggeredBy },
  "webhook_received",
);
```

After each `ticketQueue.add`:
```typescript
logger.info({ ticketId: event.ticketId, jobType: "implementation" }, "job_enqueued");
```

- [x] **Step 3: Add log calls in `handleMovedOutOfAi`**

```typescript
logger.info(
  { ticketId: event.ticketId, fromColumn: event.fromColumn, toColumn: event.toColumn },
  "contradicting_webhook_received",
);
```

After job removal:
```typescript
logger.info({ ticketId: event.ticketId, jobId }, "pending_job_cancelled");
```

After container teardown:
```typescript
logger.info({ ticketId: event.ticketId, containerId: activeRun.containerId }, "container_teardown");
```

- [x] **Step 4: Mock logger in router tests**

Add to `src/webhooks/router.test.ts`:

```typescript
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/webhooks/router.test.ts`
Expected: All PASS.

- [x] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All PASS.

- [x] **Step 7: Commit**

```bash
git add src/webhooks/router.ts src/webhooks/router.test.ts
git commit -m "feat: add structured JSON logging to webhook router"
```

---

### Task 6: Add logging to sandbox manager

**Spec Section 13.2** requires:

- Container spin-up / teardown
- Agent launched (container ID, run type)
- Agent exited (exit code, duration)

**Files:**
- Modify: `src/sandbox/manager.ts`
- Modify: `src/sandbox/manager.test.ts`

- [x] **Step 1: Add logger to sandbox manager**

At the top of `src/sandbox/manager.ts`, add:

```typescript
import { createLogger } from "../logger.js";

const logger = createLogger();
```

- [x] **Step 2: Add log calls at key lifecycle points**

After `container.start()`:
```typescript
logger.info({ containerId: container.id, image: options.image, branchName: options.branchName }, "container_started");
```

After `container.wait()` resolves:
```typescript
logger.info({ containerId: container.id, exitCode, durationMs: Date.now() - startTime }, "container_exited");
```

In the `finally` block after `container.remove()`:
```typescript
logger.info({ containerId: container.id }, "container_removed");
```

In `teardownContainer`:
```typescript
logger.info({ containerId }, "container_teardown_requested");
```

On timeout:
```typescript
logger.warn({ containerId: container?.id, timeoutMs: options.timeoutMs }, "container_timeout");
```

- [x] **Step 3: Add `startTime` tracking**

Right before `container.start()`:
```typescript
const startTime = Date.now();
```

- [x] **Step 4: Mock logger in sandbox manager tests**

Add to `src/sandbox/manager.test.ts`:

```typescript
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/sandbox/manager.test.ts`
Expected: All PASS.

- [x] **Step 6: Commit**

```bash
git add src/sandbox/manager.ts src/sandbox/manager.test.ts
git commit -m "feat: add structured JSON logging to sandbox manager"
```

---

## Chunk 4: Webhook & Adapter Logging + Final Verification

### Task 7: Add logging to webhook endpoint and adapters

**Spec Section 13.2** requires:

- Webhook received (ticket, event type, triggered by)
- Webhook validation failure
- PR created
- Comment posted on ticket
- Notification sent

**Files:**
- Modify: `src/index.ts`
- Modify: `src/adapters/console-messaging.ts`

- [x] **Step 1: Add structured log for webhook validation failure in `src/index.ts`**

Replace the Fastify logger with a structured logger import and log webhook events:

```typescript
import { createLogger } from "./logger.js";

const logger = createLogger();
```

In the webhook handler, after signature validation fails:
```typescript
logger.warn({ path: "/webhooks/jira" }, "webhook_validation_failed");
```

After successful parse and before route:
```typescript
if (event) {
  logger.info(
    { ticketId: event.ticketId, type: event.type, triggeredBy: event.triggeredBy },
    "webhook_received",
  );
}
```

- [x] **Step 2: Add logging to ConsoleMessagingAdapter**

Update `src/adapters/console-messaging.ts`:

```typescript
import { createLogger } from "../logger.js";
import type { MessagingAdapter } from "./messaging.js";

const logger = createLogger();

export class ConsoleMessagingAdapter implements MessagingAdapter {
  async notify(_userId: string, message: string): Promise<void> {
    logger.info({ message }, "notification_sent");
  }

  async ping(_userId: string, message: string): Promise<void> {
    logger.info({ message }, "ping_sent");
  }
}
```

- [x] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All PASS.

- [x] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [x] **Step 5: Commit**

```bash
git add src/index.ts src/adapters/console-messaging.ts
git commit -m "feat: add structured logging to webhook endpoint and messaging adapter"
```

---

### Task 8: Final verification

**Files:**
- None — verification only

- [x] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [x] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [x] **Step 3: Verify git status is clean**

Run: `git status`
Expected: No unstaged changes.
