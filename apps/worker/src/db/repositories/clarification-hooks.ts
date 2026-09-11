import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { ClarificationStatus } from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import { activeRuns, clarificationRequests, workflowRuns } from "../schema.js";

export interface HookClarificationRow {
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
  hookToken: string;
  askedAt: Date;
  expiresAt: Date | null;
  answer: string | null;
  answeredById: string | null;
  answeredByLabel: string | null;
  answeredAt: Date | null;
  snapshotId: string | null;
  sourceSandboxId: string | null;
  snapshotExpiresAt: Date | null;
  cleanupState: string;
}

function mapHookRow(row: typeof clarificationRequests.$inferSelect): HookClarificationRow {
  if (!row.subjectKey || !row.hookToken) {
    throw new Error(`clarification ${row.id} is missing its hook identity`);
  }
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    subjectKey: row.subjectKey,
    runId: row.runId,
    blockId: row.blockId,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    questions: row.questions,
    suggestedAnswers: row.suggestedAnswers,
    status: row.status as ClarificationStatus,
    hookToken: row.hookToken,
    askedAt: row.askedAt,
    expiresAt: row.expiresAt,
    answer: row.answer,
    answeredById: row.answeredById,
    answeredByLabel: row.answeredByLabel,
    answeredAt: row.answeredAt,
    snapshotId: row.snapshotId,
    sourceSandboxId: row.sourceSandboxId,
    snapshotExpiresAt: row.snapshotExpiresAt,
    cleanupState: row.cleanupState,
  };
}

export async function prepareHookClarification(
  db: Db,
  input: {
    ticketKey: string | null;
    subjectKey: string;
    runId: string;
    blockId: string;
    definitionId: number | null;
    definitionVersion: number | null;
    questions: string[];
    suggestedAnswers?: string[] | null;
  },
): Promise<HookClarificationRow> {
  const id = randomUUID();
  const hookToken = `clarification:${id}`;
  const [row] = await db
    .insert(clarificationRequests)
    .values({
      id,
      ticketKey: input.ticketKey,
      subjectKey: input.subjectKey,
      runId: input.runId,
      blockId: input.blockId,
      definitionId: input.definitionId,
      definitionVersion: input.definitionVersion,
      questions: input.questions,
      suggestedAnswers: input.suggestedAnswers ?? null,
      status: "preparing",
      hookToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    })
    .returning();
  if (!row) throw new Error("failed to prepare clarification");
  return mapHookRow(row);
}

export async function recordHookClarificationSnapshot(
  db: Db,
  id: string,
  snapshot: { snapshotId: string; sourceSandboxId: string; expiresAt: Date },
): Promise<void> {
  const [updated] = await db
    .update(clarificationRequests)
    .set({
      snapshotId: snapshot.snapshotId,
      sourceSandboxId: snapshot.sourceSandboxId,
      snapshotExpiresAt: snapshot.expiresAt,
      cleanupState: "retained",
    })
    .where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "preparing")))
    .returning({ id: clarificationRequests.id });
  if (!updated) throw new Error(`clarification ${id} is no longer preparing`);
}

export async function publishHookClarification(db: Db, id: string): Promise<HookClarificationRow> {
  const [row] = await db
    .update(clarificationRequests)
    .set({ status: "pending", publishedAt: new Date() })
    .where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "preparing")))
    .returning();
  if (!row) throw new Error(`clarification ${id} is no longer preparing`);
  return mapHookRow(row);
}

export async function getHookClarification(db: Db, id: string): Promise<HookClarificationRow | null> {
  const [row] = await db.select().from(clarificationRequests).where(eq(clarificationRequests.id, id)).limit(1);
  return row?.hookToken ? mapHookRow(row) : null;
}

const resumableBoundClaim = sql`exists (
  select 1 from ${activeRuns}
  where ${activeRuns.subjectKey} = ${clarificationRequests.subjectKey}
    and ${activeRuns.runId} = ${clarificationRequests.runId}
    and ${activeRuns.state} = 'bound'
)`;

export async function getResumableClarificationForTicket(db: Db, ticketKey: string): Promise<HookClarificationRow | null> {
  const [row] = await db.select().from(clarificationRequests).where(and(
    eq(clarificationRequests.ticketKey, ticketKey),
    inArray(clarificationRequests.status, ["pending", "answered"]),
    isNotNull(clarificationRequests.hookToken),
    resumableBoundClaim,
  )).orderBy(desc(clarificationRequests.askedAt)).limit(1);
  return row?.hookToken ? mapHookRow(row) : null;
}

export function getConnectedResumableClarificationForTicket(ticketKey: string) {
  return getResumableClarificationForTicket(getDb(), ticketKey);
}

export async function claimAnsweredClarificationResume(
  db: Db,
  row: { runId: string; subjectKey: string | null; ticketKey: string | null },
): Promise<"claimed" | "in_progress" | "resumed" | "settled"> {
  const claimable = sql`(${workflowRuns.status} is null or ${workflowRuns.status} = 'awaiting' or (${workflowRuns.status} = 'resuming' and (${workflowRuns.updatedAt} is null or ${workflowRuns.updatedAt} < now() - interval '60000 milliseconds')))`;
  const result = await db.execute(sql`
    WITH claimed AS (
      UPDATE workflow_runs SET status = 'resuming', updated_at = now()
      WHERE run_id = ${row.runId} AND ${claimable}
      RETURNING 'claimed'::text AS outcome
    ), inserted AS (
      INSERT INTO workflow_runs (run_id, subject_key, ticket_key, status)
      SELECT ${row.runId}, ${row.subjectKey}, ${row.ticketKey}, 'resuming'
      WHERE NOT EXISTS (SELECT 1 FROM claimed)
      ON CONFLICT DO NOTHING
      RETURNING 'claimed'::text AS outcome
    )
    SELECT outcome FROM claimed
    UNION ALL SELECT outcome FROM inserted
    UNION ALL
    SELECT CASE status WHEN 'running' THEN 'resumed' WHEN 'resuming' THEN 'in_progress' ELSE 'settled' END
    FROM workflow_runs
    WHERE run_id = ${row.runId}
      AND NOT EXISTS (SELECT 1 FROM claimed)
      AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1
  `);
  const outcome = (result as { rows?: Array<{ outcome?: string }> }).rows?.[0]?.outcome;
  if (outcome) {
    return outcome as "claimed" | "in_progress" | "resumed" | "settled";
  }

  const current = await db.execute(sql`
    SELECT status
    FROM ${workflowRuns}
    WHERE run_id = ${row.runId}
    LIMIT 1
  `);
  const status = (current as { rows?: Array<{ status?: string | null }> }).rows?.[0]?.status;
  if (status === "running") return "resumed";
  if (status === "resuming") return "in_progress";
  return "settled";
}

export function claimConnectedAnsweredClarificationResume(
  row: Parameters<typeof claimAnsweredClarificationResume>[1],
) {
  return claimAnsweredClarificationResume(getDb(), row);
}

export async function finishAnsweredClarificationResumeClaim(
  db: Db,
  input: { runId: string; status: "awaiting" | "running" | "blocked" },
): Promise<void> {
  await db.update(workflowRuns).set({ status: input.status, updatedAt: sql`now()` })
    .where(and(eq(workflowRuns.runId, input.runId), eq(workflowRuns.status, "resuming")));
}

export function finishConnectedAnsweredClarificationResumeClaim(
  input: Parameters<typeof finishAnsweredClarificationResumeClaim>[1],
) {
  return finishAnsweredClarificationResumeClaim(getDb(), input);
}

export async function getResumableClarificationForRun(db: Db, runId: string): Promise<HookClarificationRow | null> {
  const [row] = await db.select().from(clarificationRequests).where(and(
    eq(clarificationRequests.runId, runId),
    inArray(clarificationRequests.status, ["pending", "answered"]),
    isNotNull(clarificationRequests.hookToken),
    resumableBoundClaim,
  )).orderBy(desc(clarificationRequests.askedAt)).limit(1);
  return row?.hookToken ? mapHookRow(row) : null;
}

export function getConnectedResumableClarificationForRun(runId: string) {
  return getResumableClarificationForRun(getDb(), runId);
}

export async function getResumeFailedClarificationForRun(db: Db, runId: string): Promise<HookClarificationRow | null> {
  const [row] = await db.select().from(clarificationRequests).where(and(
    eq(clarificationRequests.runId, runId),
    eq(clarificationRequests.status, "resume_failed"),
    isNotNull(clarificationRequests.hookToken),
  )).orderBy(desc(clarificationRequests.askedAt)).limit(1);
  return row?.hookToken ? mapHookRow(row) : null;
}

export function getConnectedResumeFailedClarificationForRun(runId: string) {
  return getResumeFailedClarificationForRun(getDb(), runId);
}

export async function answerHookClarification(
  db: Db,
  id: string,
  answer: string,
  actor: { id: string; label: string },
): Promise<HookClarificationRow | null> {
  const [row] = await db.update(clarificationRequests).set({
    status: "answered",
    answer,
    answeredById: actor.id,
    answeredByLabel: actor.label,
    answeredAt: new Date(),
  }).where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "pending"))).returning();
  return row ? mapHookRow(row) : null;
}

export async function markHookClarificationCleanup(
  db: Db,
  id: string,
  result: { status: "deleted" } | { status: "failed"; error: string },
): Promise<void> {
  await db.update(clarificationRequests).set(
    result.status === "deleted"
      ? { cleanupState: "deleted", cleanupError: null }
      : { cleanupState: "failed", cleanupError: result.error.slice(0, 2000) },
  ).where(eq(clarificationRequests.id, id));
}

async function supersedePreparingHookClarification(db: Db, id: string): Promise<void> {
  await db.update(clarificationRequests).set({ status: "superseded" }).where(and(
    eq(clarificationRequests.id, id),
    sql`${clarificationRequests.status} in ('preparing', 'pending')`,
  ));
}

export function prepareConnectedHookClarification(input: Parameters<typeof prepareHookClarification>[1]) {
  return prepareHookClarification(getDb(), input);
}

export function recordConnectedHookClarificationSnapshot(
  id: string,
  snapshot: Parameters<typeof recordHookClarificationSnapshot>[2],
) {
  return recordHookClarificationSnapshot(getDb(), id, snapshot);
}

export function publishConnectedHookClarification(id: string) {
  return publishHookClarification(getDb(), id);
}

export function getConnectedHookClarification(id: string) {
  return getHookClarification(getDb(), id);
}

export function answerConnectedHookClarification(
  id: string,
  answer: string,
  actor: Parameters<typeof answerHookClarification>[3],
) {
  return answerHookClarification(getDb(), id, answer, actor);
}

export function markConnectedHookClarificationCleanup(
  id: string,
  result: Parameters<typeof markHookClarificationCleanup>[2],
) {
  return markHookClarificationCleanup(getDb(), id, result);
}

export function supersedeConnectedPreparingHookClarification(id: string) {
  return supersedePreparingHookClarification(getDb(), id);
}
