import { and, asc, desc, eq, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { ClarificationRequest, ClarificationStatus } from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import { activeRuns, clarificationRequests } from "../schema.js";
import { ActiveRunOwnerError } from "./active-run-owner-error.js";

interface ActiveRunOwner {
  subjectKey: string;
  ownerToken: string;
  runId: string | null;
}

export interface ClarificationRow {
  id: string;
  ticketKey: string | null;
  subjectKey: string;
  runId: string;
  blockId: string | null;
  definitionId: number | null;
  definitionVersion: number | null;
  questions: string[];
  suggestedAnswers: string[] | null;
  status: ClarificationStatus;
  hookToken: string | null;
  askedAt: Date;
  answer: string | null;
  answeredById: string | null;
  answeredByLabel: string | null;
  answeredAt: Date | null;
  dispatchedRunId: null;
  snapshotId: string | null;
  sourceSandboxId: string | null;
  snapshotExpiresAt: Date | null;
  cleanupState: string;
  cleanupError: string | null;
}

type SelectRow = typeof clarificationRequests.$inferSelect;

function mapRow(row: SelectRow): ClarificationRow {
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    subjectKey: row.subjectKey ?? (row.ticketKey ? `ticket:jira:${row.ticketKey}` : row.id),
    runId: row.runId,
    blockId: row.blockId,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    questions: row.questions,
    suggestedAnswers: row.suggestedAnswers,
    status: row.status as ClarificationStatus,
    hookToken: row.hookToken,
    askedAt: row.askedAt,
    answer: row.answer,
    answeredById: row.answeredById,
    answeredByLabel: row.answeredByLabel,
    answeredAt: row.answeredAt,
    dispatchedRunId: null,
    snapshotId: row.snapshotId,
    sourceSandboxId: row.sourceSandboxId,
    snapshotExpiresAt: row.snapshotExpiresAt,
    cleanupState: row.cleanupState,
    cleanupError: row.cleanupError,
  };
}

async function getClarificationForRun(
  db: Db,
  runId: string,
): Promise<ClarificationRow | null> {
  const [row] = await db
    .select()
    .from(clarificationRequests)
    .where(eq(clarificationRequests.runId, runId))
    .orderBy(desc(clarificationRequests.askedAt))
    .limit(1);
  return row ? mapRow(row) : null;
}

export function getConnectedClarificationForRun(runId: string) {
  return getClarificationForRun(getDb(), runId);
}

export function supersedeConnectedPendingClarificationsForTicket(ticketKey: string) {
  return supersedePendingForTicket(getDb(), ticketKey);
}

export function supersedeConnectedClarification(id: string) {
  return supersedeClarification(getDb(), id);
}

async function listAnsweredForTicket(
  db: Db,
  ticketKey: string,
): Promise<ClarificationRow[]> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.ticketKey, ticketKey),
        eq(clarificationRequests.status, "answered"),
      ),
    )
    .orderBy(asc(clarificationRequests.askedAt));
  return rows.map(mapRow);
}

export interface ProtectedClarificationSubjects {
  all: string[];
  retained: string[];
  terminal: string[];
}

/**
 * A pending hook must bypass generic orphan handling while its ticket is parked
 * outside the AI column. Once answered, the same Workflow may keep running, so
 * route it through terminal-only reconciliation: that path retains non-terminal
 * runs and releases only after the whole Workflow and its steps have drained.
 */
export async function classifyProtectedClarificationSubjects(
  db: Db,
): Promise<ProtectedClarificationSubjects> {
  const rows = await db
    .select({
      subjectKey: clarificationRequests.subjectKey,
      status: clarificationRequests.status,
    })
    .from(clarificationRequests)
    .where(
      and(
        isNotNull(clarificationRequests.subjectKey),
        inArray(clarificationRequests.status, ["pending", "answered"]),
        sql`exists (
          select 1 from ${activeRuns}
          where ${activeRuns.subjectKey} = ${clarificationRequests.subjectKey}
            and ${activeRuns.runId} = ${clarificationRequests.runId}
            and ${activeRuns.state} = 'bound'
        )`,
      ),
    );
  const retainedSet = new Set<string>();
  const terminalSet = new Set<string>();
  for (const row of rows) {
    if (!row.subjectKey) continue;
    if (row.status === "pending") retainedSet.add(row.subjectKey);
    else terminalSet.add(row.subjectKey);
  }
  // A newer pending round keeps the same run suspended even when older rounds
  // are answered.
  for (const subjectKey of retainedSet) terminalSet.delete(subjectKey);

  const retained = [...retainedSet].sort();
  const terminal = [...terminalSet].sort();
  const all = [...new Set([...retained, ...terminal])].sort();
  return { all, retained, terminal };
}

export function classifyConnectedProtectedClarificationSubjects() {
  return classifyProtectedClarificationSubjects(getDb());
}

export async function supersedePendingForTicket(
  db: Db,
  ticketKey: string,
): Promise<number> {
  const rows = await db
    .update(clarificationRequests)
    .set({ status: "superseded" })
    .where(
      and(
        eq(clarificationRequests.ticketKey, ticketKey),
        eq(clarificationRequests.status, "pending"),
      ),
    )
    .returning({ id: clarificationRequests.id });
  return rows.length;
}

export async function supersedeClarification(db: Db, id: string): Promise<number> {
  const rows = await db
    .update(clarificationRequests)
    .set({ status: "superseded" })
    .where(
      and(
        eq(clarificationRequests.id, id),
        inArray(clarificationRequests.status, ["preparing", "pending", "answered"]),
      ),
    )
    .returning({ id: clarificationRequests.id });
  return rows.length;
}

export async function reconcileClarificationPickupState(
  db: Db,
  input: { ticketKey: string; currentRunId: string; owner: ActiveRunOwner },
): Promise<{ superseded: number; resolvedAwaiting: number }> {
  const result = await db.execute(sql`
    WITH exact_owner AS MATERIALIZED (
      SELECT subject_key
      FROM active_runs
      WHERE subject_key = ${input.owner.subjectKey}
        AND owner_token = ${input.owner.ownerToken}
        AND run_id = ${input.owner.runId}
        AND state = 'bound'
      FOR UPDATE
    ), superseded AS (
      UPDATE clarification_requests
      SET status = 'superseded'
      WHERE ticket_key = ${input.ticketKey}
        AND status = 'pending'
        AND run_id <> ${input.currentRunId}
        AND EXISTS (SELECT 1 FROM exact_owner)
      RETURNING id
    ), resolved_awaiting AS (
      UPDATE workflow_runs
      SET status = 'blocked', updated_at = now()
      WHERE ticket_key = ${input.ticketKey}
        AND status = 'awaiting'
        AND run_id <> ${input.currentRunId}
        AND EXISTS (SELECT 1 FROM exact_owner)
      RETURNING run_id
    )
    SELECT
      (SELECT count(*)::integer FROM exact_owner) AS owner_count,
      (SELECT count(*)::integer FROM superseded) AS superseded_count,
      (SELECT count(*)::integer FROM resolved_awaiting) AS resolved_awaiting_count
  `);
  const row = ((result as { rows?: Array<{
    owner_count: number;
    resolved_awaiting_count: number;
    superseded_count: number;
  }> }).rows ?? [])[0];
  if (Number(row?.owner_count ?? 0) !== 1) {
    throw new ActiveRunOwnerError(
      "Cannot reconcile clarification pickup without the exact bound owner.",
    );
  }
  return {
    superseded: Number(row?.superseded_count ?? 0),
    resolvedAwaiting: Number(row?.resolved_awaiting_count ?? 0),
  };
}

export function reconcileConnectedClarificationPickupState(
  input: Parameters<typeof reconcileClarificationPickupState>[1],
) {
  return reconcileClarificationPickupState(getDb(), input);
}

export function listConnectedAnsweredClarificationsForTicket(ticketKey: string) {
  return listAnsweredForTicket(getDb(), ticketKey);
}

export async function tombstoneClarificationCancellation(
  db: Db,
  input: { subjectKey: string; ownerToken: string; runId: string | null },
): Promise<{ matched: boolean; successorOwnerToken: null }> {
  const rows = await db
    .update(clarificationRequests)
    .set({ status: "superseded" })
    .where(
      and(
        eq(clarificationRequests.subjectKey, input.subjectKey),
        inArray(clarificationRequests.status, ["preparing", "pending", "answered"]),
        ...(input.runId ? [eq(clarificationRequests.runId, input.runId)] : []),
      ),
    )
    .returning({ id: clarificationRequests.id });
  return { matched: rows.length > 0, successorOwnerToken: null };
}

export function tombstoneConnectedClarificationCancellation(
  input: Parameters<typeof tombstoneClarificationCancellation>[1],
) {
  return tombstoneClarificationCancellation(getDb(), input);
}

/** Reserve a delivery of one exact answered clarification generation. */
export async function reserveClarificationResumeAttempt(
  db: Db,
  input: { id: string; answeredAt: Date; maxAttempts: number },
): Promise<number | null> {
  const [row] = await db
    .update(clarificationRequests)
    .set({
      resumeAttempts: sql`coalesce(${clarificationRequests.resumeAttempts}, 0) + 1`,
    })
    .where(
      and(
        eq(clarificationRequests.id, input.id),
        eq(clarificationRequests.status, "answered"),
        eq(clarificationRequests.answeredAt, input.answeredAt),
        lt(sql`coalesce(${clarificationRequests.resumeAttempts}, 0)`, input.maxAttempts),
      ),
    )
    .returning({ resumeAttempts: clarificationRequests.resumeAttempts });
  return row?.resumeAttempts ?? null;
}

/** Retire an exhausted clarification delivery and fail its linked run atomically. */
export async function terminalizeClarificationResume(
  db: Db,
  input: { id: string; runId: string; answeredAt: Date; maxAttempts: number; reason: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH terminal_clarification AS (
      UPDATE clarification_requests
      SET status = 'resume_failed'
      WHERE id = ${input.id}
        AND status = 'answered'
        AND resume_attempts >= ${input.maxAttempts}
        AND answered_at = ${input.answeredAt}
        AND EXISTS (
          SELECT 1 FROM workflow_runs WHERE workflow_runs.run_id = ${input.runId}
        )
      RETURNING id, run_id
    ), failed_run AS (
      UPDATE workflow_runs
      SET status = 'failed',
          status_reason = ${input.reason},
          completed_at = coalesce(completed_at, now()),
          duration_sec = coalesce(
            duration_sec,
            case
              when coalesce(started_at, created_at) is not null
              then greatest(0, extract(epoch from (now() - coalesce(started_at, created_at)))::int)
              else null
            end
          ),
          updated_at = now()
      FROM terminal_clarification
      WHERE workflow_runs.run_id = terminal_clarification.run_id
        AND coalesce(workflow_runs.status, 'running')
          NOT IN ('success', 'failed', 'blocked')
      RETURNING workflow_runs.run_id
    )
    SELECT terminal_clarification.id
    FROM terminal_clarification
    LEFT JOIN failed_run ON failed_run.run_id = terminal_clarification.run_id
  `);
  return ((result as { rows?: Array<{ id: string }> }).rows ?? []).length === 1;
}

export function reserveConnectedClarificationResumeAttempt(
  input: Parameters<typeof reserveClarificationResumeAttempt>[1],
) {
  return reserveClarificationResumeAttempt(getDb(), input);
}

export function terminalizeConnectedClarificationResume(
  input: Parameters<typeof terminalizeClarificationResume>[1],
) {
  return terminalizeClarificationResume(getDb(), input);
}

export function listExpiredPendingHookClarifications(db: Db, now: Date) {
  return db
    .select({
      id: clarificationRequests.id,
      hookToken: clarificationRequests.hookToken,
      snapshotId: clarificationRequests.snapshotId,
    })
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.status, "pending"),
        isNotNull(clarificationRequests.hookToken),
        lte(clarificationRequests.expiresAt, now),
      ),
    );
}

export function listConnectedExpiredPendingHookClarifications(now: Date) {
  return listExpiredPendingHookClarifications(getDb(), now);
}

export async function supersedePendingHookClarification(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .update(clarificationRequests)
    .set({ status: "superseded" })
    .where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "pending")))
    .returning({ id: clarificationRequests.id });
  return Boolean(row);
}

export function supersedeConnectedPendingHookClarification(id: string): Promise<boolean> {
  return supersedePendingHookClarification(getDb(), id);
}

export async function recordClarificationSnapshotCleanup(
  db: Db,
  input: { id: string; state: "deleted" | "failed"; error: string | null },
): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({ cleanupState: input.state, cleanupError: input.error })
    .where(eq(clarificationRequests.id, input.id));
}

export function recordConnectedClarificationSnapshotCleanup(
  input: Parameters<typeof recordClarificationSnapshotCleanup>[1],
) {
  return recordClarificationSnapshotCleanup(getDb(), input);
}

export function serializeClarification(row: ClarificationRow): ClarificationRequest {
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    runId: row.runId,
    blockId: row.blockId,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    questions: row.questions,
    suggestedAnswers: row.suggestedAnswers,
    status: row.status,
    askedAt: row.askedAt.toISOString(),
    answer: row.answer,
    answeredById: row.answeredById,
    answeredByLabel: row.answeredByLabel,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    dispatchedRunId: null,
  };
}
