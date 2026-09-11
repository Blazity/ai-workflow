import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Db } from "../../client.js";
import { activeRuns, workflowRuns } from "../../schema.js";

export interface StartupWatchdogDueRun {
  runId: string;
  subjectKey: string | null;
  ticketKey: string | null;
  diagnosticId: string | null;
  ownerToken: string | null;
  ownerRunId: string | null;
  ownerState: string | null;
}

export async function listStartupWatchdogDueRuns(
  db: Db,
  input: { now: Date; terminalStatuses: readonly string[]; limit: number },
): Promise<StartupWatchdogDueRun[]> {
  return db
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
        sql`${workflowRuns.startupDeadlineAt} <= ${input.now}`,
        sql`coalesce(${workflowRuns.status}, 'running') not in (${sql.join(
          input.terminalStatuses.map((status) => sql`${status}`),
          sql`, `,
        )})`,
      ),
    )
    .limit(input.limit);
}

export async function claimStartupWatchdogTimeout(
  db: Db,
  input: {
    runId: string;
    now: Date;
    diagnosticId: string;
    terminalStatuses: readonly string[];
  },
): Promise<string | null> {
  const rows = await db
    .update(workflowRuns)
    .set({
      diagnosticId: sql`coalesce(${workflowRuns.diagnosticId}, ${input.diagnosticId})`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(workflowRuns.runId, input.runId),
        isNull(workflowRuns.entryStartedAt),
        sql`${workflowRuns.startupDeadlineAt} <= ${input.now}`,
        sql`coalesce(${workflowRuns.status}, 'running') not in (${sql.join(
          input.terminalStatuses.map((status) => sql`${status}`),
          sql`, `,
        )})`,
      ),
    )
    .returning({ diagnosticId: workflowRuns.diagnosticId });
  return rows[0]?.diagnosticId ?? null;
}

export async function persistStartupWatchdogDiagnosticId(
  db: Db,
  input: { runId: string; diagnosticId: string },
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({
      diagnosticId: sql`coalesce(${workflowRuns.diagnosticId}, ${input.diagnosticId})`,
      updatedAt: sql`now()`,
    })
    .where(eq(workflowRuns.runId, input.runId));
}

export async function insertOrphanStartedRun(
  db: Db,
  input: {
    runId: string;
    subjectKey: string;
    ticketKey: string | null;
    diagnosticId: string;
    reason: string;
  },
): Promise<void> {
  await db
    .insert(workflowRuns)
    .values({
      runId: input.runId,
      status: "running",
      statusReason: input.reason,
      subjectKey: input.subjectKey,
      ticketKey: input.ticketKey,
      createdAt: sql`now()`,
      startedAt: sql`now()`,
      startupDeadlineAt: sql`now()`,
      diagnosticId: input.diagnosticId,
    })
    .onConflictDoNothing({ target: workflowRuns.runId });
}

export async function insertNoDefinitionBlockedRun(
  db: Db,
  input: {
    runId: string;
    subjectKey: string;
    ticketKey: string;
    ticketTitle: string | null;
    reason: string;
  },
): Promise<boolean> {
  const [latest] = await db
    .select({ status: workflowRuns.status, statusReason: workflowRuns.statusReason })
    .from(workflowRuns)
    .where(eq(workflowRuns.subjectKey, input.subjectKey))
    .orderBy(desc(workflowRuns.firstSeenAt))
    .limit(1);
  if (latest?.status === "blocked" && latest.statusReason === input.reason) return false;
  await db.insert(workflowRuns).values({
    runId: input.runId,
    status: "blocked",
    statusReason: input.reason,
    subjectKey: input.subjectKey,
    ticketKey: input.ticketKey,
    ticketTitle: input.ticketTitle,
    createdAt: sql`now()`,
    startedAt: sql`now()`,
    completedAt: sql`now()`,
    durationSec: 0,
  });
  return true;
}

export function insertConnectedOrphanStartedRun(
  input: Parameters<typeof insertOrphanStartedRun>[1],
): Promise<void> {
  return insertOrphanStartedRun(getDb(), input);
}

export function insertConnectedNoDefinitionBlockedRun(
  input: Parameters<typeof insertNoDefinitionBlockedRun>[1],
): Promise<boolean> {
  return insertNoDefinitionBlockedRun(getDb(), input);
}

export async function markStartupRunFailure(
  db: Db,
  input: { runId: string; diagnosticId: string; reason: string },
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({
      status: "failed",
      statusReason: input.reason,
      diagnosticId: input.diagnosticId,
      completedAt: sql`coalesce(${workflowRuns.completedAt}, now())`,
      durationSec: sql`coalesce(${workflowRuns.durationSec}, greatest(0, extract(epoch from (now() - coalesce(${workflowRuns.startedAt}, ${workflowRuns.createdAt})))::int))`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(workflowRuns.runId, input.runId), isNull(workflowRuns.entryStartedAt)));
}

export function markConnectedStartupRunFailure(
  input: Parameters<typeof markStartupRunFailure>[1],
): Promise<void> {
  return markStartupRunFailure(getDb(), input);
}
