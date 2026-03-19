# Workflow-Level Cancellation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a user moves a ticket out of the AI column, cancel the workflow run at the framework level (not just kill the container), so the workflow runtime knows the run is cancelled and releases hooks/waits/steps.

**Architecture:** Add `workflowRunId` column to `run_attempts` and `"cancelled"` to `runStatusEnum`. Move run_attempts creation from inside workflows to the call sites (webhook router, maintenance). On cancellation, post `run_cancelled` event to the workflow runtime AND teardown the container AND update run_attempts status.

**Tech Stack:** Drizzle ORM, @workflow/core (Run.cancel(), world.events.create), PostgreSQL, dockerode

---

### Task 1: Schema changes

**Files:**
- Modify: `packages/shared/src/schema.ts`

**Step 1: Add "cancelled" to runStatusEnum and workflowRunId column**

In `packages/shared/src/schema.ts`, update the `runStatusEnum` to include `"cancelled"`:

```typescript
export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "preparing_sandbox",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "clarification_needed",
  "cancelled",
]);
```

Add `workflowRunId` to the `runAttempts` table definition:

```typescript
export const runAttempts = pgTable(
  "run_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id),
    attemptNumber: integer("attempt_number").notNull().default(1),
    type: runTypeEnum("type").notNull(),
    status: runStatusEnum("status").notNull().default("pending"),
    workflowRunId: text("workflow_run_id"),
    containerId: text("container_id"),
    branchName: text("branch_name"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [index("run_attempts_ticket_id_idx").on(t.ticketId)],
);
```

**Step 2: Generate the migration**

Run: `pnpm drizzle-kit generate`

This creates a new SQL migration file in `drizzle/`. Verify it contains:
- `ALTER TYPE "public"."run_status" ADD VALUE 'cancelled';`
- `ALTER TABLE "run_attempts" ADD COLUMN "workflow_run_id" text;`

**Step 3: Commit**

```
feat: add cancelled status and workflowRunId to run_attempts schema
```

---

### Task 2: Extract `startWorkflowRun` helper

**Files:**
- Create: `packages/app/src/lib/workflow-helpers.ts`

There are 7 call sites that follow the same pattern: insert run_attempts → start workflow → store workflowRunId. Extract this into a shared helper.

**Step 1: Create the helper module**

Create `packages/app/src/lib/workflow-helpers.ts`:

```typescript
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { db, runAttempts, tickets, createLogger } from "@blazebot/shared";

const logger = createLogger();

/**
 * Create a run_attempts row, start the workflow, and store the workflow run ID.
 * Returns the run_attempts row ID.
 */
export async function startWorkflowRun(options: {
  ticketRowId: string;
  ticketExternalId: string;
  type: "implementation" | "review_fix";
  branchName?: string;
  workflow: (...args: any[]) => any;
  workflowArgs: any[];
  dedupeId: string;
}): Promise<string> {
  const [run] = await db
    .insert(runAttempts)
    .values({
      ticketId: options.ticketRowId,
      type: options.type,
      status: "pending",
      branchName: options.branchName,
    })
    .returning();

  await db
    .update(tickets)
    .set({ currentRunId: run!.id, updatedAt: new Date() })
    .where(eq(tickets.id, options.ticketRowId));

  const handle = await start(options.workflow, options.workflowArgs, {
    id: options.dedupeId,
  });

  await db
    .update(runAttempts)
    .set({ workflowRunId: handle.runId })
    .where(eq(runAttempts.id, run!.id));

  logger.info(
    {
      ticketId: options.ticketExternalId,
      runAttemptId: run!.id,
      workflowRunId: handle.runId,
      type: options.type,
    },
    "workflow_run_started",
  );

  return run!.id;
}

/**
 * Cancel an active workflow run: cancel at the framework level, teardown
 * the container, and update the run_attempts record.
 */
export async function cancelWorkflowRun(options: {
  runAttemptId: string;
  workflowRunId: string | null;
  containerId: string | null;
  ticketExternalId: string;
}): Promise<void> {
  // 1. Cancel at the workflow framework level
  if (options.workflowRunId) {
    try {
      const world = getWorld();
      await world.events.create(options.workflowRunId, {
        eventType: "run_cancelled",
        specVersion: 2,
      });
      logger.info(
        { ticketId: options.ticketExternalId, workflowRunId: options.workflowRunId },
        "workflow_run_cancelled",
      );
    } catch (err) {
      // Run may already be in a terminal state — log and continue
      logger.warn(
        {
          ticketId: options.ticketExternalId,
          workflowRunId: options.workflowRunId,
          error: (err as Error).message,
        },
        "workflow_cancel_failed",
      );
    }
  }

  // 2. Teardown the container
  if (options.containerId) {
    const { teardownContainer } = await import("../sandbox/manager.js");
    try {
      await teardownContainer(options.containerId);
      logger.info(
        { ticketId: options.ticketExternalId, containerId: options.containerId },
        "container_teardown_direct",
      );
    } catch (err) {
      logger.warn(
        {
          ticketId: options.ticketExternalId,
          containerId: options.containerId,
          error: (err as Error).message,
        },
        "container_teardown_failed",
      );
    }
  }

  // 3. Update the run_attempts record
  await db
    .update(runAttempts)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(runAttempts.id, options.runAttemptId));
}
```

**Step 2: Commit**

```
feat: add startWorkflowRun and cancelWorkflowRun helpers
```

---

### Task 3: Update webhook router — call sites

**Files:**
- Modify: `packages/app/src/lib/webhook-router.ts`

Replace all 4 `start()` call sites in `handleMovedToAi` with `startWorkflowRun`, and rewrite `handleMovedOutOfAi` to use `cancelWorkflowRun`.

**Step 1: Update imports**

Replace:
```typescript
import { start } from "workflow/api";
```
With:
```typescript
import { startWorkflowRun, cancelWorkflowRun } from "./workflow-helpers.js";
```

Keep the `teardownContainer` import removed — `cancelWorkflowRun` handles it internally.

Remove:
```typescript
import { teardownContainer } from "../sandbox/manager.js";
```

**Step 2: Rewrite the 4 start() call sites in handleMovedToAi**

Each `start()` call becomes a `startWorkflowRun()` call. The workflow now receives a `runAttemptId` as a 4th argument.

**Path 1 — new ticket (line ~95):**
```typescript
    await startWorkflowRun({
      ticketRowId: created.id,
      ticketExternalId: event.ticketId,
      type: "implementation",
      workflow: implementTicket,
      workflowArgs: [event.ticketId, "jira", event.triggeredBy, created.id],
      dedupeId: `impl-${event.ticketId}-${created.id}`,
    });
```

Note: `created.id` is passed as both `ticketRowId` (for the helper) and as the 4th workflow arg (so the workflow knows the run_attempts ID). Wait — the run_attempts ID is created inside `startWorkflowRun`, not equal to `created.id` (which is the ticket ID). The workflow needs the **run attempt ID** as its 4th arg. Since `startWorkflowRun` returns the run attempt ID, we need to capture it. But the workflow args are passed to `start()` inside the helper, before we know the run attempt ID...

Actually, re-read the helper: the run_attempts row is inserted FIRST (getting `run!.id`), THEN `start()` is called with `options.workflowArgs`. So we need to restructure: pass a function that receives the runAttemptId and returns the args, OR pass the runAttemptId into the workflow args array after creation.

Revised helper signature — add `runAttemptId` to the workflow args automatically:

Actually simpler: have `startWorkflowRun` append the `runAttemptId` to the args automatically. Update the helper:

```typescript
  const handle = await start(options.workflow, [...options.workflowArgs, run!.id], {
    id: options.dedupeId,
  });
```

This way every workflow receives its `runAttemptId` as the last argument. The call sites don't need to know about it.

**Path 1 — new ticket:**
```typescript
    await startWorkflowRun({
      ticketRowId: created.id,
      ticketExternalId: event.ticketId,
      type: "implementation",
      workflow: implementTicket,
      workflowArgs: [event.ticketId, "jira", event.triggeredBy],
      dedupeId: `impl-${event.ticketId}-${created.id}`,
    });
```

**Path 2 — clarification_pending (line ~108):**
```typescript
    await startWorkflowRun({
      ticketRowId: ticket.id,
      ticketExternalId: event.ticketId,
      type: "implementation",
      workflow: implementTicket,
      workflowArgs: [event.ticketId, "jira", event.triggeredBy],
      dedupeId: `impl-${event.ticketId}-${ticket.id}`,
    });
```

**Path 3 — awaiting_review (line ~121):**
```typescript
    await startWorkflowRun({
      ticketRowId: ticket.id,
      ticketExternalId: event.ticketId,
      type: "review_fix",
      workflow: reviewFixTicket,
      workflowArgs: [event.ticketId, "jira", event.triggeredBy],
      dedupeId: `fix-${event.ticketId}-${ticket.id}`,
    });
```

**Path 4 — failed re-enqueue (line ~139):**
```typescript
    await startWorkflowRun({
      ticketRowId: ticket.id,
      ticketExternalId: event.ticketId,
      type: "implementation",
      workflow: implementTicket,
      workflowArgs: [event.ticketId, "jira", event.triggeredBy],
      dedupeId: `impl-${event.ticketId}-${ticket.id}`,
    });
```

**Step 3: Rewrite handleMovedOutOfAi to use cancelWorkflowRun**

Replace the container teardown block (lines 177–197) and add run_attempts update + currentRunId cleanup:

```typescript
async function handleMovedOutOfAi(event: NormalizedEvent): Promise<void> {
  const existing = await db
    .select()
    .from(tickets)
    .where(
      and(eq(tickets.externalId, event.ticketId), eq(tickets.source, "jira")),
    );

  const ticket = existing[0];
  if (!ticket) return;

  const to = normalize(event.toColumn);
  const colAiReview = normalize(env.COLUMN_AI_REVIEW);
  const colBacklog = normalize(env.COLUMN_BACKLOG);

  if (ticket.workflowState === "awaiting_review" && to === colAiReview) {
    logger.info({ ticketId: event.ticketId, toColumn: event.toColumn }, "self_transition_ignored");
    return;
  }
  if (ticket.workflowState === "clarification_pending" && to === colBacklog) {
    logger.info({ ticketId: event.ticketId, toColumn: event.toColumn }, "self_transition_ignored");
    return;
  }

  logger.info(
    { ticketId: event.ticketId, fromColumn: event.fromColumn, toColumn: event.toColumn },
    "contradicting_webhook_received",
  );

  if (ticket.currentRunId) {
    const runRows = await db
      .select()
      .from(runAttempts)
      .where(eq(runAttempts.id, ticket.currentRunId));
    const activeRun = runRows[0];
    if (activeRun) {
      await cancelWorkflowRun({
        runAttemptId: activeRun.id,
        workflowRunId: activeRun.workflowRunId,
        containerId: activeRun.containerId,
        ticketExternalId: event.ticketId,
      });
    }
  }

  await db
    .update(tickets)
    .set({
      workflowState: "failed",
      state: event.toColumn,
      currentRunId: null,
      updatedAt: new Date(),
    })
    .where(eq(tickets.id, ticket.id));

  logger.info(
    { ticketId: event.ticketId, from: ticket.workflowState, to: "failed" },
    "ticket_state_transition",
  );
}
```

**Step 4: Commit**

```
feat: use workflow helpers in webhook router for start and cancel
```

---

### Task 4: Update workflow functions to receive runAttemptId

**Files:**
- Modify: `packages/app/src/workflows/implementation.ts`
- Modify: `packages/app/src/workflows/review-fix.ts`

Both workflows now receive `runAttemptId` as their last argument. Their `createRun` step changes from INSERT to UPDATE.

**Step 1: Update implementTicket**

Change the function signature:
```typescript
export async function implementTicket(
  ticketId: string,
  source: "jira" | "linear",
  triggeredBy: string,
  runAttemptId: string,
) {
```

Remove the `const run = await createRun(...)` call. Use `runAttemptId` directly everywhere `run.id` was used:

```typescript
export async function implementTicket(
  ticketId: string,
  source: "jira" | "linear",
  triggeredBy: string,
  runAttemptId: string,
) {
  "use workflow";

  const ticket = await fetchAndValidateTicket(ticketId);
  if (!ticket) return; // stale, skip silently

  const branchName = `blazebot/${ticketId}`;

  await setupBranch(ticketId, branchName, runAttemptId);
  const result = await executeSandbox(ticketId, branchName, ticket);

  if (result.containerId) {
    await recordContainerId(runAttemptId, result.containerId);
  }

  if (result.status === "complete" && result.containerId) {
    const pushResult = await pushAndTeardown(result.containerId, branchName);
    if (!pushResult.pushed) {
      await finalizeFailure(ticketId, runAttemptId, `Branch push failed — agent may not have committed code. Output: ${pushResult.output}`);
      throw new Error(`Push failed for ${ticketId}: ${pushResult.output}`);
    }
    const pr = await createPullRequest(ticketId, ticket.title, branchName, result.summary ?? "");
    await finalizeSuccess(ticketId, runAttemptId, branchName, pr, triggeredBy, ticket.identifier);
    return;
  }

  if (result.status === "clarification_needed") {
    if (result.containerId) {
      await pushAndTeardown(result.containerId, branchName);
    }
    await finalizeClarification(ticketId, runAttemptId, branchName, result.questions ?? [], triggeredBy, ticket.identifier);
    return;
  }

  // Failed
  if (result.containerId) {
    await teardownStep(result.containerId);
  }
  await finalizeFailure(ticketId, runAttemptId, result.error);
  throw new Error(`Agent failed for ${ticketId}: ${result.error}`);
}
```

**Step 2: Update setupBranch to accept runAttemptId and mark it running**

```typescript
async function setupBranch(ticketId: string, branchName: string, runAttemptId: string) {
  "use step";
  const { github } = createAdapters();
  const owner = appEnv.GITHUB_REPO_OWNER!;
  const repo = appEnv.GITHUB_REPO_NAME!;
  const baseBranch = appEnv.GITHUB_BASE_BRANCH;

  await github.createBranch(owner, repo, branchName, baseBranch);

  await db
    .update(tickets)
    .set({ workflowState: "implementing", updatedAt: new Date() })
    .where(eq(tickets.externalId, ticketId));

  await db
    .update(runAttempts)
    .set({ status: "running", branchName })
    .where(eq(runAttempts.id, runAttemptId));

  logger.info({ ticketId, from: "queued", to: "implementing" }, "ticket_state_transition");
}
```

**Step 3: Remove the old createRun step**

Delete the entire `createRun` function (lines ~110-134 in implementation.ts). It's no longer needed.

**Step 4: Update reviewFixTicket the same way**

Change signature to include `runAttemptId`:
```typescript
export async function reviewFixTicket(
  ticketId: string,
  source: "jira" | "linear",
  triggeredBy: string,
  runAttemptId: string,
) {
```

Remove `createFixRun` step. Move its DB updates into `validateReviewFix`:

```typescript
export async function reviewFixTicket(
  ticketId: string,
  source: "jira" | "linear",
  triggeredBy: string,
  runAttemptId: string,
) {
  "use workflow";

  const validation = await validateReviewFix(ticketId, runAttemptId);
  if (!validation) return; // stale or missing data

  const { branchName, prNumber } = validation;
  const result = await executeFixSandbox(ticketId, branchName, prNumber);

  if (result.containerId) {
    await recordContainerId(runAttemptId, result.containerId);
  }

  if (result.status === "complete" && result.containerId) {
    await pushAndTeardown(result.containerId, branchName);
    await finalizeFixSuccess(ticketId, runAttemptId, triggeredBy);
    return;
  }

  // Failed
  if (result.containerId) {
    await teardownStep(result.containerId);
  }
  await finalizeFixFailure(ticketId, runAttemptId, result.error);
  throw new Error(`Agent failed for ${ticketId}: ${result.error}`);
}
```

Update `validateReviewFix` to mark the run as running:

```typescript
async function validateReviewFix(ticketId: string, runAttemptId: string) {
  "use step";
  const { jira } = createAdapters();
  const ticket = await jira.fetchTicket(ticketId);

  const colAi = normalize(env.COLUMN_AI);
  if (normalize(ticket.trackerStatus) !== colAi) {
    logger.info({ ticketId, trackerStatus: ticket.trackerStatus }, "stale_job_skipped");
    return null;
  }

  const ticketRow = (
    await db.select().from(tickets).where(eq(tickets.externalId, ticketId))
  )[0]!;

  if (!ticketRow.prId || !ticketRow.branchName) {
    throw new FatalError(`review_fix requires prId and branchName for ${ticketId}`);
  }

  await db
    .update(tickets)
    .set({ workflowState: "fixing_feedback", updatedAt: new Date() })
    .where(eq(tickets.externalId, ticketId));

  await db
    .update(runAttempts)
    .set({ status: "running", branchName: ticketRow.branchName })
    .where(eq(runAttempts.id, runAttemptId));

  return {
    branchName: ticketRow.branchName,
    prNumber: parseInt(ticketRow.prId, 10),
  };
}
```

Remove the old `createFixRun` step entirely.

**Step 5: Commit**

```
refactor: workflows receive runAttemptId from caller instead of creating their own
```

---

### Task 5: Update maintenance workflow call sites

**Files:**
- Modify: `packages/app/src/workflows/maintenance.ts`

**Step 1: Import the helper**

Add at the top:
```typescript
import { startWorkflowRun, cancelWorkflowRun } from "../lib/workflow-helpers.js";
```

**Step 2: Update checkMissedWebhooks — new ticket discovery (line ~103)**

Replace:
```typescript
      await start(implementTicket, [ticketId, "jira", "poller"], {
        id: `impl-${ticketId}-${created.id}`,
      });
```
With:
```typescript
      await startWorkflowRun({
        ticketRowId: created.id,
        ticketExternalId: ticketId,
        type: "implementation",
        workflow: implementTicket,
        workflowArgs: [ticketId, "jira", "poller"],
        dedupeId: `impl-${ticketId}-${created.id}`,
      });
```

**Step 3: Update checkMissedWebhooks — failed ticket re-enqueue (line ~126)**

Replace:
```typescript
      await start(implementTicket, [ticketId, "jira", ticket.assignee ?? "poller"], {
        id: `impl-${ticketId}-${ticket.id}-${Date.now()}`,
      });
```
With:
```typescript
      await startWorkflowRun({
        ticketRowId: ticket.id,
        ticketExternalId: ticketId,
        type: "implementation",
        workflow: implementTicket,
        workflowArgs: [ticketId, "jira", ticket.assignee ?? "poller"],
        dedupeId: `impl-${ticketId}-${ticket.id}-${Date.now()}`,
      });
```

**Step 4: Update checkStuckJobs to cancel workflow run**

Replace the container teardown + run_attempts update block (lines ~157-181) with `cancelWorkflowRun`:

```typescript
    if (ticket.currentRunId) {
      const runRows = await db
        .select()
        .from(runAttempts)
        .where(eq(runAttempts.id, ticket.currentRunId));
      const activeRun = runRows[0];

      if (activeRun) {
        await cancelWorkflowRun({
          runAttemptId: activeRun.id,
          workflowRunId: activeRun.workflowRunId,
          containerId: activeRun.containerId,
          ticketExternalId: ticket.externalId,
        });
      }
    }
```

Note: `cancelWorkflowRun` already sets `status: "cancelled"` on the run. But for stuck jobs we want `"timed_out"`. Override after the cancel call:

```typescript
      if (activeRun) {
        await cancelWorkflowRun({
          runAttemptId: activeRun.id,
          workflowRunId: activeRun.workflowRunId,
          containerId: activeRun.containerId,
          ticketExternalId: ticket.externalId,
        });
        // Override status for stuck jobs — they timed out, not user-cancelled
        await db
          .update(runAttempts)
          .set({ status: "timed_out" })
          .where(eq(runAttempts.id, activeRun.id));
      }
```

**Step 5: Update the re-enqueue start() call (line ~209)**

Replace:
```typescript
    await start(workflowFn, [ticket.externalId, ticket.source as "jira" | "linear", ticket.assignee ?? "poller"], {
      id: `${jobType === "review_fix" ? "fix" : "impl"}-${ticket.externalId}-${ticket.id}-${Date.now()}`,
    });
```
With:
```typescript
    await startWorkflowRun({
      ticketRowId: ticket.id,
      ticketExternalId: ticket.externalId,
      type: jobType === "review_fix" ? "review_fix" : "implementation",
      workflow: workflowFn,
      workflowArgs: [ticket.externalId, ticket.source as "jira" | "linear", ticket.assignee ?? "poller"],
      dedupeId: `${jobType === "review_fix" ? "fix" : "impl"}-${ticket.externalId}-${ticket.id}-${Date.now()}`,
    });
```

**Step 6: Remove unused `start` import**

Remove `import { start } from "workflow/api";` — now handled by the helper.

Also remove `import { teardownContainer } from "../sandbox/manager.js";` — now handled by `cancelWorkflowRun`.

**Step 7: Commit**

```
feat: use workflow helpers in maintenance for start and cancel
```

---

### Task 6: Build verification

**Step 1: Run the build**

Run: `pnpm build` (or the project's build command)

Fix any TypeScript errors — likely candidates:
- The `workflowRunId` column needs to be accessed via `activeRun.workflowRunId` (verify drizzle infers the column correctly from the schema)
- Ensure `start()` return type includes `.runId` — the `Run` class from `workflow/api` exposes this

**Step 2: Run the migration against a local database**

Run: `pnpm drizzle-kit push` (or `pnpm drizzle-kit migrate`)

Verify the migration applies cleanly.

**Step 3: Commit any fixes**

```
fix: address build errors from workflow cancellation changes
```
