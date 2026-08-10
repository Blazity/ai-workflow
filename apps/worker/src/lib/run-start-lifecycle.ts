import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getRun } from "workflow/api";
import type {
  RunRegistryAdapter,
  StartedRunRecord,
} from "../adapters/run-registry/types.js";
import { getDb, type Db } from "../db/client.js";
import { activeRuns, workflowRuns } from "../db/schema.js";
import { confirmWorkflowStepsDrained } from "./workflow-step-drain.js";
import { logger } from "./logger.js";
import { cancelSubjectRun } from "./cancel-run.js";
import { STARTUP_DEADLINE_MS } from "./run-start-constants.js";

export { STARTUP_DEADLINE_MS } from "./run-start-constants.js";
export const STARTUP_TIMEOUT_REASON =
  "Workflow did not start within 10 minutes.";
const LOST_START_OWNERSHIP_REASON =
  "Hosted workflow start lost dispatch ownership.";
const STARTUP_WATCHDOG_LIMIT = 50;
const TERMINAL_LOCAL_STATUSES = [
  "success",
  "failed",
  "blocked",
  "awaiting",
  "completed",
  "cancelled",
] as const;
const TERMINAL_HOSTED_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export async function commitHostedStart(
  runRegistry: RunRegistryAdapter,
  started: StartedRunRecord,
): Promise<boolean> {
  try {
    if (await runRegistry.commitStartedRun(started)) return true;
  } catch (error) {
    logger.warn(
      {
        subjectKey: started.subjectKey,
        runId: started.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      "dispatch_start_commit_failed",
    );
    const owner = await runRegistry.get(started.subjectKey);
    if (
      owner?.ownerToken === started.ownerToken &&
      owner.runId === started.runId &&
      owner.state === "bound"
    ) {
      // This is the only place in the start flow that infers the workflow_runs
      // row from the claim state instead of observing it. Production produced a
      // phantom run twice on 2026-08-10: the claim was bound to this run id, the
      // occurrence ledger recorded a start, and no workflow_runs row ever
      // existed, so the run was invisible in the runs list. Observe the row.
      let outcome: { status: string | null } | null;
      try {
        const { findRunOutcomeByRunId } = await import(
          "../db/queries/runs-read.js"
        );
        outcome = await findRunOutcomeByRunId(getDb(), started.runId);
      } catch (checkError) {
        logger.warn(
          {
            subjectKey: started.subjectKey,
            runId: started.runId,
            ownerToken: started.ownerToken,
            claimState: owner.state,
            error:
              checkError instanceof Error
                ? checkError.message
                : String(checkError),
          },
          "dispatch_start_run_row_check_unconfirmed",
        );
        // Deliberate: falling through cancels the hosted run, so an unreadable
        // database must never kill a healthy start. Only a confirmed absence of
        // the row justifies the orphan path.
        return true;
      }
      if (outcome) return true;
      logger.warn(
        {
          subjectKey: started.subjectKey,
          runId: started.runId,
          ownerToken: started.ownerToken,
          claimState: owner.state,
        },
        "dispatch_start_bound_without_run_row",
      );
    }
  }
  await recordAndCancelOrphanStartedRun(started);
  return false;
}

export async function recordAndCancelOrphanStartedRun(
  started: StartedRunRecord,
): Promise<void> {
  const db = getDb();
  const diagnosticId = diagnosticIdForStartup();
  try {
    await db
      .insert(workflowRuns)
      .values({
        runId: started.runId,
        status: "running",
        statusReason: LOST_START_OWNERSHIP_REASON,
        subjectKey: started.subjectKey,
        ticketKey: started.ticketKey,
        createdAt: sql`now()`,
        startedAt: sql`now()`,
        startupDeadlineAt: sql`now()`,
        diagnosticId,
      })
      .onConflictDoNothing({ target: workflowRuns.runId });
  } catch (error) {
    logger.warn(
      {
        subjectKey: started.subjectKey,
        runId: started.runId,
        diagnosticId,
        error: error instanceof Error ? error.message : String(error),
      },
      "dispatch_orphan_candidate_record_failed",
    );
  }
  const cancelled = await cancelUnownedHostedRun(started.runId);
  if (cancelled) {
    await markStartupFailure(
      db,
      started.runId,
      diagnosticId,
      LOST_START_OWNERSHIP_REASON,
    );
  }
  logger.warn(
    {
      subjectKey: started.subjectKey,
      runId: started.runId,
      diagnosticId,
      cancellationConfirmed: cancelled,
    },
    "dispatch_orphan_candidate",
  );
}

export const NO_DEFINITION_BLOCKED_REASON =
  "No enabled workflow definition currently handles the trigger_ticket_ai trigger, so this ticket was never picked up. Enable a workflow definition whose trigger is the AI column.";

/**
 * A ticket the dispatcher skips for want of a definition never reaches a hosted
 * run, so without this row the dashboard, Slack and Jira show nothing at all and
 * the ticket sits in the AI column forever. Record one terminal "blocked" row
 * carrying the cause instead. Best-effort by contract: the caller's dispatch
 * result must not change because bookkeeping failed.
 *
 * The poll retries the same ticket every minute, so a run row is written only
 * when the subject's most recent one is not already this same block. Anything
 * newer (a real run, or a different block) makes the ticket visible again.
 */
export async function recordNoDefinitionBlockedRun(input: {
  subjectKey: string;
  ticketKey: string;
  ticketTitle: string | null;
}): Promise<void> {
  try {
    const db = getDb();
    const [latest] = await db
      .select({
        status: workflowRuns.status,
        statusReason: workflowRuns.statusReason,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.subjectKey, input.subjectKey))
      .orderBy(desc(workflowRuns.firstSeenAt))
      .limit(1);
    if (
      latest?.status === "blocked" &&
      latest.statusReason === NO_DEFINITION_BLOCKED_REASON
    ) {
      return;
    }
    await db.insert(workflowRuns).values({
      runId: `no_definition_${randomUUID()}`,
      status: "blocked",
      statusReason: NO_DEFINITION_BLOCKED_REASON,
      subjectKey: input.subjectKey,
      ticketKey: input.ticketKey,
      ticketTitle: input.ticketTitle,
      createdAt: sql`now()`,
      startedAt: sql`now()`,
      completedAt: sql`now()`,
      durationSec: 0,
    });
  } catch (error) {
    logger.warn(
      {
        subjectKey: input.subjectKey,
        ticketKey: input.ticketKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "dispatch_no_definition_record_failed",
    );
  }
}

export interface StartupWatchdogResult {
  selected: number;
  cancelled: number;
  retryable: number;
}

export async function reconcileStartupWatchdog(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
  now?: Date;
  onSubjectReleased?: (subjectKey: string) => Promise<void> | void;
}): Promise<StartupWatchdogResult> {
  const now = input.now ?? new Date();
  const due = await input.db
    .select({
      runId: workflowRuns.runId,
      subjectKey: workflowRuns.subjectKey,
      ticketKey: workflowRuns.ticketKey,
      diagnosticId: workflowRuns.diagnosticId,
      ownerToken: activeRuns.ownerToken,
      ownerRunId: activeRuns.runId,
      ownerState: activeRuns.state,
    })
    .from(workflowRuns)
    .leftJoin(
      activeRuns,
      and(
        eq(activeRuns.subjectKey, workflowRuns.subjectKey),
        eq(activeRuns.runId, workflowRuns.runId),
      ),
    )
    .where(
      and(
        isNull(workflowRuns.entryStartedAt),
        sql`${workflowRuns.startupDeadlineAt} <= ${now}`,
        sql`coalesce(${workflowRuns.status}, 'running') not in (${sql.join(
          TERMINAL_LOCAL_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )})`,
      ),
    )
    .limit(STARTUP_WATCHDOG_LIMIT);

  const result: StartupWatchdogResult = {
    selected: due.length,
    cancelled: 0,
    retryable: 0,
  };
  for (const row of due) {
    const diagnosticId = await claimStartupTimeout(
      input.db,
      row.runId,
      now,
      row.diagnosticId ?? diagnosticIdForStartup(),
    );
    if (!diagnosticId) continue;
    if (!row.subjectKey) {
      result.retryable++;
      continue;
    }
    const confirmed =
      row.ownerToken &&
      row.ownerRunId === row.runId &&
      row.ownerState !== "reserved"
        ? await cancelSubjectRun(
            row.subjectKey,
            { ownerToken: row.ownerToken, runId: row.runId },
            input.runRegistry,
            input.onSubjectReleased,
            STARTUP_TIMEOUT_REASON,
          )
        : await cancelUnownedHostedRun(row.runId);
    if (!confirmed) {
      await persistDiagnosticId(input.db, row.runId, diagnosticId);
      result.retryable++;
      continue;
    }
    await markStartupFailure(input.db, row.runId, diagnosticId);
    result.cancelled++;
  }
  return result;
}

async function claimStartupTimeout(
  db: Db,
  runId: string,
  now: Date,
  diagnosticId: string,
): Promise<string | null> {
  const rows = await db
    .update(workflowRuns)
    .set({
      diagnosticId: sql`coalesce(${workflowRuns.diagnosticId}, ${diagnosticId})`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(workflowRuns.runId, runId),
        isNull(workflowRuns.entryStartedAt),
        sql`${workflowRuns.startupDeadlineAt} <= ${now}`,
        sql`coalesce(${workflowRuns.status}, 'running') not in (${sql.join(
          TERMINAL_LOCAL_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )})`,
      ),
    )
    .returning({ diagnosticId: workflowRuns.diagnosticId });
  return rows[0]?.diagnosticId ?? null;
}

async function cancelUnownedHostedRun(runId: string): Promise<boolean> {
  const run = getRun(runId);
  try {
    await run.cancel();
  } catch (error) {
    let status: string;
    try {
      status = await run.status;
    } catch (statusError) {
      logger.warn(
        {
          runId,
          error: error instanceof Error ? error.message : String(error),
          statusError:
            statusError instanceof Error
              ? statusError.message
              : String(statusError),
        },
        "startup_watchdog_cancel_unconfirmed",
      );
      return false;
    }
    if (!TERMINAL_HOSTED_STATUSES.has(status)) return false;
  }
  let status: string;
  try {
    status = await run.status;
  } catch (error) {
    logger.warn(
      {
        runId,
        error: error instanceof Error ? error.message : String(error),
      },
      "startup_watchdog_status_unconfirmed",
    );
    return false;
  }
  if (!TERMINAL_HOSTED_STATUSES.has(status)) return false;
  return confirmWorkflowStepsDrained("startup-watchdog", runId);
}

async function markStartupFailure(
  db: Db,
  runId: string,
  diagnosticId: string,
  reason = STARTUP_TIMEOUT_REASON,
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({
      status: "failed",
      statusReason: reason,
      diagnosticId,
      completedAt: sql`coalesce(${workflowRuns.completedAt}, now())`,
      durationSec: sql`coalesce(${workflowRuns.durationSec}, greatest(0, extract(epoch from (now() - coalesce(${workflowRuns.startedAt}, ${workflowRuns.createdAt})))::int))`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(workflowRuns.runId, runId),
        isNull(workflowRuns.entryStartedAt),
      ),
    );
}

async function persistDiagnosticId(
  db: Db,
  runId: string,
  diagnosticId: string,
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({
      diagnosticId: sql`coalesce(${workflowRuns.diagnosticId}, ${diagnosticId})`,
      updatedAt: sql`now()`,
    })
    .where(eq(workflowRuns.runId, runId));
}

function diagnosticIdForStartup(): string {
  return `diag_${randomUUID()}`;
}
