import { randomBytes } from "node:crypto";
import type { WorkflowBlockType } from "@shared/contracts";
import { and, asc, desc, eq, getTableColumns, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { activeRuns, scheduleOccurrences, workflowRuns, workflowSchedules } from "../schema.js";

export type ScheduleOverlapPolicy = "skip" | "queue" | "allow";
export type ScheduleRow = typeof workflowSchedules.$inferSelect;
export type ScheduleOccurrenceRow = typeof scheduleOccurrences.$inferSelect;
export interface MintableScheduleNode {
  id: string;
  type: WorkflowBlockType;
  configuration?: Record<string, unknown>;
}
export interface AuthoredSchedule {
  cron: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  catchUpGraceMinutes: number;
}
export interface MintedSchedule { scheduleId: string; nodeId: string; minted: boolean; }

const OVERLAP_POLICIES = ["skip", "queue", "allow"] as const;

export function generateScheduleId(): string {
  return `sch_${randomBytes(12).toString("hex")}`;
}

/** One row upsert; deployment orchestration invokes it once per schedule node. */
export async function resyncSchedule(
  db: Db,
  input: { definitionId: number; nodeId: string; authored: AuthoredSchedule },
  now: Date = new Date(),
): Promise<MintedSchedule> {
  const candidateId = generateScheduleId();
  const rows = await db.insert(workflowSchedules).values({
    id: candidateId, definitionId: input.definitionId, nodeId: input.nodeId,
    cron: input.authored.cron, timezone: input.authored.timezone,
    overlapPolicy: input.authored.overlapPolicy,
    catchUpGraceMinutes: input.authored.catchUpGraceMinutes,
    evaluationWatermarkAt: now,
  }).onConflictDoUpdate({
    target: [workflowSchedules.definitionId, workflowSchedules.nodeId],
    set: {
      cron: input.authored.cron, timezone: input.authored.timezone,
      overlapPolicy: input.authored.overlapPolicy,
      catchUpGraceMinutes: input.authored.catchUpGraceMinutes,
      revokedAt: null, updatedAt: sql`now()`,
    },
  }).returning();
  const row = rows[0];
  if (!row) throw new Error("workflow schedule row disappeared after upsert");
  return { scheduleId: row.id, nodeId: row.nodeId, minted: row.id === candidateId };
}

/** Compatibility batch helper; each node delegates to the one-statement upsert. */
export async function mintSchedulesForLiveHead(
  db: Db,
  input: { definitionId: number; nodes: readonly MintableScheduleNode[] },
  now: Date = new Date(),
): Promise<MintedSchedule[]> {
  const results: MintedSchedule[] = [];
  for (const node of input.nodes) {
    if (node.type === "trigger_schedule") {
      results.push(await resyncSchedule(db, {
        definitionId: input.definitionId, nodeId: node.id, authored: authoredFrom(node),
      }, now));
    }
  }
  return results;
}

export async function getScheduleById(db: Db, scheduleId: string): Promise<ScheduleRow | null> {
  const rows = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, scheduleId)).limit(1);
  return rows[0] ?? null;
}

export function getConnectedScheduleById(scheduleId: string) {
  return getScheduleById(getDb(), scheduleId);
}

export async function settleScheduleOccurrenceOnCancel(db: Db, runId: string): Promise<boolean> {
  const rows = await db.update(scheduleOccurrences).set({
    outcome: "run_cancelled",
    updatedAt: sql`now()`,
  }).where(and(eq(scheduleOccurrences.runId, runId), eq(scheduleOccurrences.outcome, "started")))
    .returning({ occurrenceAt: scheduleOccurrences.occurrenceAt });
  return rows.length > 0;
}

export function settleConnectedScheduleOccurrenceOnCancel(runId: string): Promise<boolean> {
  return settleScheduleOccurrenceOnCancel(getDb(), runId);
}

export async function cancelWaitingScheduleOccurrences(
  db: Db,
  input: { scheduleId: string; reason: string; overwriteReason: boolean },
): Promise<number> {
  const rows = await db.update(scheduleOccurrences).set({
    outcome: "cancelled",
    pending: false,
    skipReason: input.overwriteReason
      ? input.reason
      : sql`coalesce(${scheduleOccurrences.skipReason}, ${input.reason})`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(scheduleOccurrences.scheduleId, input.scheduleId),
    eq(scheduleOccurrences.pending, true),
  )).returning({ scheduleId: scheduleOccurrences.scheduleId });
  return rows.length;
}

const scheduleOccurrenceIsUnsettled = sql`(${scheduleOccurrences.pending} = true
  OR ${scheduleOccurrences.outcome} IS NULL)`;

export async function getScheduleOccurrence(
  db: Db,
  input: { scheduleId: string; occurrenceAt: Date },
): Promise<ScheduleOccurrenceRow | null> {
  const [row] = await db
    .select()
    .from(scheduleOccurrences)
    .where(and(
      eq(scheduleOccurrences.scheduleId, input.scheduleId),
      eq(scheduleOccurrences.occurrenceAt, input.occurrenceAt),
    ))
    .limit(1);
  return row ?? null;
}

export function getConnectedScheduleOccurrence(
  input: Parameters<typeof getScheduleOccurrence>[1],
) {
  return getScheduleOccurrence(getDb(), input);
}

export async function recordSkippedScheduleOccurrence(
  db: Db,
  input: {
    scheduleId: string;
    occurrenceAt: Date;
    outcome: "skipped_overlap" | "skipped_stale";
    skipReason?: string;
    blockingRunId?: string;
  },
): Promise<boolean> {
  const rows = await db
    .update(scheduleOccurrences)
    .set({
      outcome: input.outcome,
      pending: false,
      skipReason: sql`coalesce(${input.skipReason ?? null}, ${scheduleOccurrences.skipReason})`,
      blockingRunId: input.blockingRunId ?? null,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(scheduleOccurrences.scheduleId, input.scheduleId),
      eq(scheduleOccurrences.occurrenceAt, input.occurrenceAt),
      scheduleOccurrenceIsUnsettled,
    ))
    .returning({ scheduleId: scheduleOccurrences.scheduleId });
  return rows.length === 1;
}

export async function recordScheduleOccurrenceError(
  db: Db,
  input: { scheduleId: string; occurrenceAt: Date; message: string },
): Promise<boolean> {
  const rows = await db.update(scheduleOccurrences).set({
    outcome: "error",
    skipReason: input.message,
    attemptCount: sql`${scheduleOccurrences.attemptCount} + 1`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(scheduleOccurrences.scheduleId, input.scheduleId),
    eq(scheduleOccurrences.occurrenceAt, input.occurrenceAt),
    scheduleOccurrenceIsUnsettled,
  )).returning({ scheduleId: scheduleOccurrences.scheduleId });
  return rows.length === 1;
}

export async function recordScheduleOccurrenceAtCapacity(
  db: Db,
  input: { scheduleId: string; occurrenceAt: Date },
): Promise<boolean> {
  const rows = await db.update(scheduleOccurrences).set({
    skipReason: "at_capacity",
    attemptCount: sql`${scheduleOccurrences.attemptCount} + 1`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(scheduleOccurrences.scheduleId, input.scheduleId),
    eq(scheduleOccurrences.occurrenceAt, input.occurrenceAt),
    eq(scheduleOccurrences.pending, true),
  )).returning({ scheduleId: scheduleOccurrences.scheduleId });
  return rows.length === 1;
}

export async function expirePendingScheduleOccurrences(
  db: Db,
  input: { now: Date; maxAgeMs: number },
): Promise<number> {
  const rows = await db.update(scheduleOccurrences).set({
    outcome: "expired",
    pending: false,
    skipReason: sql`coalesce(${scheduleOccurrences.skipReason}, 'expired_before_dispatch')`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(scheduleOccurrences.pending, true),
    lt(scheduleOccurrences.createdAt, new Date(input.now.getTime() - input.maxAgeMs)),
  )).returning({ scheduleId: scheduleOccurrences.scheduleId });
  return rows.length;
}

export function listPendingScheduleOccurrences(
  db: Db,
  limit: number,
): Promise<ScheduleOccurrenceRow[]> {
  return db.select(getTableColumns(scheduleOccurrences)).from(scheduleOccurrences)
    .innerJoin(workflowSchedules, eq(workflowSchedules.id, scheduleOccurrences.scheduleId))
    .where(and(
      eq(scheduleOccurrences.pending, true),
      isNull(workflowSchedules.pausedAt),
      isNull(workflowSchedules.revokedAt),
    ))
    .orderBy(asc(scheduleOccurrences.occurrenceAt))
    .limit(limit);
}

export function listScheduleOccurrences(
  db: Db,
  scheduleId: string,
  limit: number,
): Promise<ScheduleOccurrenceRow[]> {
  return db.select().from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.scheduleId, scheduleId))
    .orderBy(desc(scheduleOccurrences.occurrenceAt))
    .limit(limit);
}

export async function listSchedulesForDefinition(db: Db, definitionId: number): Promise<ScheduleRow[]> {
  return db.select().from(workflowSchedules).where(eq(workflowSchedules.definitionId, definitionId)).orderBy(asc(workflowSchedules.nodeId));
}

export function listConnectedSchedulesForDefinition(definitionId: number) {
  return listSchedulesForDefinition(getDb(), definitionId);
}

export function listConnectedOccurrencesForSchedule(scheduleId: string, limit: number) {
  return getDb().select().from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.scheduleId, scheduleId))
    .orderBy(sql`${scheduleOccurrences.occurrenceAt} desc`).limit(limit);
}

export async function pauseSchedule(db: Db, scheduleId: string, now: Date = new Date()): Promise<void> {
  await pauseWorkflowSchedule(db, { scheduleId, now });
}

export function pauseConnectedSchedule(scheduleId: string) {
  return pauseSchedule(getDb(), scheduleId);
}

export async function resumeSchedule(db: Db, scheduleId: string, now: Date = new Date()): Promise<void> {
  await db.update(workflowSchedules).set({
    pausedAt: null,
    evaluationWatermarkAt: sql`${now}::timestamptz - (${workflowSchedules.catchUpGraceMinutes} * interval '1 minute')`,
    updatedAt: sql`now()`,
  }).where(and(eq(workflowSchedules.id, scheduleId), isNotNull(workflowSchedules.pausedAt)));
}

export function resumeConnectedSchedule(scheduleId: string) {
  return resumeSchedule(getDb(), scheduleId);
}

export async function revokeSchedule(db: Db, scheduleId: string, now: Date = new Date()): Promise<void> {
  await db.update(workflowSchedules).set({ revokedAt: now, updatedAt: sql`now()` })
    .where(and(eq(workflowSchedules.id, scheduleId), isNull(workflowSchedules.revokedAt)));
}

export async function advanceWatermark(db: Db, scheduleId: string, occurrenceAt: Date): Promise<boolean> {
  const rows = await db.update(workflowSchedules).set({ evaluationWatermarkAt: occurrenceAt, updatedAt: sql`now()` })
    .where(and(eq(workflowSchedules.id, scheduleId), lt(workflowSchedules.evaluationWatermarkAt, occurrenceAt)))
    .returning({ id: workflowSchedules.id });
  return rows.length === 1;
}

export async function recordEvaluationPass(db: Db, scheduleId: string, now: Date = new Date()): Promise<void> {
  await db.update(workflowSchedules).set({ lastEvaluatedAt: now, updatedAt: sql`now()` }).where(eq(workflowSchedules.id, scheduleId));
}

export async function listEvaluableSchedules(db: Db, limit: number): Promise<ScheduleRow[]> {
  return db.select().from(workflowSchedules)
    .where(and(isNull(workflowSchedules.pausedAt), isNull(workflowSchedules.revokedAt)))
    .orderBy(sql`${workflowSchedules.lastEvaluatedAt} asc nulls first`).limit(limit);
}

export function mintConnectedSchedulesForLiveHead(
  input: Parameters<typeof mintSchedulesForLiveHead>[1],
) {
  return mintSchedulesForLiveHead(getDb(), input);
}

function authoredFrom(node: MintableScheduleNode): AuthoredSchedule {
  const config = node.configuration ?? {};
  const overlap = config.overlapPolicy;
  const grace = config.catchUpGraceMinutes;
  return {
    cron: typeof config.cron === "string" ? config.cron : "",
    timezone: typeof config.timezone === "string" && config.timezone !== "" ? config.timezone : "UTC",
    overlapPolicy: typeof overlap === "string" && OVERLAP_POLICIES.includes(overlap as ScheduleOverlapPolicy)
      ? overlap as ScheduleOverlapPolicy : "skip",
    catchUpGraceMinutes: typeof grace === "number" && Number.isInteger(grace) && grace > 0 ? grace : 60,
  };
}

export async function pauseWorkflowSchedule(
  db: Db,
  input: { scheduleId: string; now: Date },
): Promise<void> {
  await db.execute(sql`
    WITH paused AS (
      UPDATE ${workflowSchedules}
      SET paused_at = ${input.now}, updated_at = now()
      WHERE ${workflowSchedules.id} = ${input.scheduleId}
        AND ${workflowSchedules.pausedAt} IS NULL
      RETURNING ${workflowSchedules.id}
    )
    UPDATE ${scheduleOccurrences} occ
    SET outcome = 'cancelled', pending = false,
        skip_reason = coalesce(occ.skip_reason, 'schedule_paused'), updated_at = now()
    WHERE occ.schedule_id = ${input.scheduleId} AND occ.pending = true
  `);
}

export async function recordRetiredScheduleOccurrence(
  db: Db,
  input: {
    scheduleId: string;
    occurrenceAt: Date;
    definitionId: number;
    definitionVersion: number;
    droppedOlder: number;
    droppedOlderAtLeast: boolean;
    reason: string;
  },
): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO ${scheduleOccurrences} (
      schedule_id, occurrence_at, definition_id, definition_version,
      pending, outcome, skip_reason, dropped_count, dropped_count_capped
    ) VALUES (
      ${input.scheduleId}, ${input.occurrenceAt}, ${input.definitionId}, ${input.definitionVersion},
      false, 'cancelled', ${input.reason}, ${input.droppedOlder}, ${input.droppedOlderAtLeast}
    )
    ON CONFLICT (schedule_id, occurrence_at) DO UPDATE
    SET pending = false, outcome = 'cancelled', skip_reason = ${input.reason}, updated_at = now()
    WHERE ${scheduleOccurrences.pending} = true OR ${scheduleOccurrences.outcome} IS NULL
    RETURNING schedule_id
  `);
  return ((result as { rows?: unknown[] }).rows ?? []).length === 1;
}

export async function sweepExpiredSettledScheduleOccurrences(
  db: Db,
  input: { cutoff: Date; minimumRetainedPerSchedule: number },
): Promise<void> {
  await db.execute(sql`
    DELETE FROM ${scheduleOccurrences} occ
    USING (
      SELECT schedule_id, occurrence_at,
        row_number() OVER (PARTITION BY schedule_id ORDER BY occurrence_at DESC) AS rn
      FROM ${scheduleOccurrences}
    ) ranked
    WHERE occ.schedule_id = ranked.schedule_id AND occ.occurrence_at = ranked.occurrence_at
      AND ranked.rn > ${input.minimumRetainedPerSchedule}
      AND occ.pending = false AND occ.outcome IS NOT NULL AND occ.created_at < ${input.cutoff}
  `);
}

export async function recordStartedScheduleOccurrence(
  db: Pick<Db, "execute">,
  input: { scheduleId: string; occurrenceAt: Date; ownerToken: string; runId: string },
): Promise<boolean> {
  const updated = await db.execute(sql`
    WITH published AS (
      UPDATE ${scheduleOccurrences}
      SET outcome = 'started', pending = false, run_id = ${input.runId},
          dispatched_at = coalesce(${scheduleOccurrences.dispatchedAt}, now()), updated_at = now()
      WHERE ${scheduleOccurrences.scheduleId} = ${input.scheduleId}
        AND ${scheduleOccurrences.occurrenceAt} = ${input.occurrenceAt}
        AND (
          ${scheduleOccurrences.pending} = true OR ${scheduleOccurrences.outcome} IS NULL
          OR (${scheduleOccurrences.outcome} = 'started' AND ${scheduleOccurrences.runId} = ${input.runId})
        )
        AND EXISTS (
          SELECT 1 FROM ${activeRuns}
          WHERE ${activeRuns.ownerToken} = ${input.ownerToken}
            AND ((${activeRuns.state} = 'reserved' AND ${activeRuns.runId} IS NULL)
              OR (${activeRuns.state} = 'bound' AND ${activeRuns.runId} = ${input.runId}))
        )
        AND EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.runId} = ${input.runId})
      RETURNING ${scheduleOccurrences.scheduleId}, ${scheduleOccurrences.occurrenceAt}
    ), fired AS (
      UPDATE ${workflowSchedules} s
      SET last_started_occurrence_at = published.occurrence_at,
          last_started_run_id = ${input.runId}, updated_at = now()
      FROM published
      WHERE s.id = published.schedule_id
        AND (s.last_started_occurrence_at IS NULL
          OR s.last_started_occurrence_at <= published.occurrence_at)
      RETURNING s.id
    )
    SELECT occurrence_at FROM published
  `);
  return ((updated as { rows?: unknown[] }).rows ?? []).length === 1;
}

export function recordConnectedStartedScheduleOccurrence(
  input: Parameters<typeof recordStartedScheduleOccurrence>[1],
): Promise<boolean> {
  return recordStartedScheduleOccurrence(getDb(), input);
}

export async function insertScheduleOccurrence(
  db: Pick<Db, "execute">,
  input: {
    scheduleId: string; occurrenceAt: Date; definitionId: number; definitionVersion: number;
    droppedOlder: number; droppedOlderAtLeast: boolean;
  },
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH blocker AS (
      SELECT occ.occurrence_at FROM ${scheduleOccurrences} occ
      WHERE occ.schedule_id = ${input.scheduleId} AND occ.pending = true LIMIT 1
    )
    INSERT INTO ${scheduleOccurrences} (
      schedule_id, occurrence_at, definition_id, definition_version,
      pending, outcome, skip_reason, dropped_count, dropped_count_capped
    )
    SELECT ${input.scheduleId}, ${input.occurrenceAt}, ${input.definitionId}, ${input.definitionVersion},
      NOT EXISTS (SELECT 1 FROM blocker),
      CASE WHEN EXISTS (SELECT 1 FROM blocker) THEN 'skipped_overlap' END,
      (SELECT 'overlap:' || to_char(b.occurrence_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM blocker b),
      ${input.droppedOlder}, ${input.droppedOlderAtLeast}
    ON CONFLICT (schedule_id, occurrence_at) DO NOTHING
    RETURNING pending
  `);
  return ((result as { rows?: Array<{ pending: boolean }> }).rows ?? [])[0]?.pending === true;
}

export async function supersedeAndInsertScheduleOccurrence(
  db: Pick<Db, "execute">,
  input: {
    scheduleId: string; occurrenceAt: Date; definitionId: number; definitionVersion: number;
    droppedOlder: number; droppedOlderAtLeast: boolean;
  },
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH superseded AS (
      UPDATE ${scheduleOccurrences} occ
      SET outcome = 'superseded', pending = false, updated_at = now()
      WHERE occ.schedule_id = ${input.scheduleId}
        AND occ.pending = true AND occ.occurrence_at < ${input.occurrenceAt}
      RETURNING occ.dropped_count, occ.dropped_count_capped
    )
    INSERT INTO ${scheduleOccurrences} (
      schedule_id, occurrence_at, definition_id, definition_version,
      pending, dropped_count, dropped_count_capped
    )
    SELECT ${input.scheduleId}, ${input.occurrenceAt}, ${input.definitionId}, ${input.definitionVersion}, true,
      ${input.droppedOlder} + (SELECT count(*) + coalesce(sum(dropped_count), 0) FROM superseded),
      ${input.droppedOlderAtLeast} OR (SELECT coalesce(bool_or(dropped_count_capped), false) FROM superseded)
    ON CONFLICT (schedule_id, occurrence_at) DO NOTHING
    RETURNING schedule_id
  `);
  return ((result as { rows?: unknown[] }).rows ?? []).length === 1;
}

export const insertConnectedScheduleOccurrence = (
  input: Parameters<typeof insertScheduleOccurrence>[1],
) => insertScheduleOccurrence(getDb(), input);
export const supersedeAndInsertConnectedScheduleOccurrence = (
  input: Parameters<typeof supersedeAndInsertScheduleOccurrence>[1],
) => supersedeAndInsertScheduleOccurrence(getDb(), input);
export const recordConnectedSkippedScheduleOccurrence = (
  input: Parameters<typeof recordSkippedScheduleOccurrence>[1],
) => recordSkippedScheduleOccurrence(getDb(), input);
export const recordConnectedScheduleOccurrenceError = (
  input: Parameters<typeof recordScheduleOccurrenceError>[1],
) => recordScheduleOccurrenceError(getDb(), input);
export const recordConnectedScheduleOccurrenceAtCapacity = (
  input: Parameters<typeof recordScheduleOccurrenceAtCapacity>[1],
) => recordScheduleOccurrenceAtCapacity(getDb(), input);
export const expireConnectedPendingScheduleOccurrences = (
  input: Parameters<typeof expirePendingScheduleOccurrences>[1],
) => expirePendingScheduleOccurrences(getDb(), input);
export const listConnectedPendingScheduleOccurrences = (limit: number) =>
  listPendingScheduleOccurrences(getDb(), limit);
export const recordConnectedRetiredScheduleOccurrence = (
  input: Parameters<typeof recordRetiredScheduleOccurrence>[1],
) => recordRetiredScheduleOccurrence(getDb(), input);
export const sweepConnectedExpiredSettledScheduleOccurrences = (
  input: Parameters<typeof sweepExpiredSettledScheduleOccurrences>[1],
) => sweepExpiredSettledScheduleOccurrences(getDb(), input);
export const advanceConnectedScheduleWatermark = (scheduleId: string, occurrenceAt: Date) =>
  advanceWatermark(getDb(), scheduleId, occurrenceAt);
export const recordConnectedScheduleEvaluationPass = (scheduleId: string, now: Date) =>
  recordEvaluationPass(getDb(), scheduleId, now);
export const listConnectedEvaluableSchedules = (limit: number) =>
  listEvaluableSchedules(getDb(), limit);
