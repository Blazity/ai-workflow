import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import type { ClarificationStatus } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { activeRuns, clarificationRequests, workflowRuns } from "../db/schema.js";

/**
 * How long a resume attempt may hold its claim before another caller may take it
 * over. One poll interval: an attempt that outlived it either finished or died
 * with its invocation, and a dead attempt must not park the run forever.
 */
export const RESUME_CLAIM_TTL_MS = 60_000;

/**
 * A run whose recorded answer still has to be delivered: parked, or never written
 * by a status-less writer, or left mid-attempt by a claim that died with its
 * invocation. Shared by the claim that takes the work and by the query that finds
 * it, so the two can never disagree about what "stalled" means.
 */
export function stalledResumeRunSql(): SQL {
  return sql`(
    ${workflowRuns.status} is null
    or ${workflowRuns.status} = 'awaiting'
    or (
      ${workflowRuns.status} = 'resuming'
      and (
        ${workflowRuns.updatedAt} is null
        or ${workflowRuns.updatedAt} < now() - (${RESUME_CLAIM_TTL_MS} * interval '1 millisecond')
      )
    )
  )`;
}

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

function mapHookRow(
  row: typeof clarificationRequests.$inferSelect,
): HookClarificationRow {
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

/** Create an unpublished row before registering its Workflow hook. */
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

/** Make a question visible only after its hook and optional snapshot are durable. */
export async function publishHookClarification(
  db: Db,
  id: string,
): Promise<HookClarificationRow> {
  const [row] = await db
    .update(clarificationRequests)
    .set({ status: "pending", publishedAt: new Date() })
    .where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "preparing")))
    .returning();
  if (!row) throw new Error(`clarification ${id} is no longer preparing`);
  return mapHookRow(row);
}

export async function getHookClarification(
  db: Db,
  id: string,
): Promise<HookClarificationRow | null> {
  const [row] = await db
    .select()
    .from(clarificationRequests)
    .where(eq(clarificationRequests.id, id))
    .limit(1);
  return row?.hookToken ? mapHookRow(row) : null;
}

/**
 * Answers that were recorded but never woke their run: the row is `answered`, the
 * asking run still holds its bound claim (so it is still suspended, still holding
 * a concurrency slot) and its run row still reads as stalled rather than resumed.
 *
 * `answeredBefore` keeps the pass off a resume that may still be in flight: the
 * dashboard route resumes without taking the claim, so recency is the only thing
 * that separates "nobody is delivering this" from "somebody just did".
 *
 * Ticketless subjects are included deliberately. A pull request park has no
 * ticket, so no comment and no column move can ever reach it, which makes this
 * pass the only automatic route it has.
 */
export async function listStalledAnsweredClarifications(
  db: Db,
  answeredBefore: Date,
): Promise<HookClarificationRow[]> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.status, "answered"),
        isNotNull(clarificationRequests.hookToken),
        isNotNull(clarificationRequests.answeredAt),
        lt(clarificationRequests.answeredAt, answeredBefore),
        sql`exists (
          select 1 from ${activeRuns}
          where ${activeRuns.subjectKey} = ${clarificationRequests.subjectKey}
            and ${activeRuns.runId} = ${clarificationRequests.runId}
            and ${activeRuns.state} = 'bound'
        )`,
        sql`exists (
          select 1 from ${workflowRuns}
          where ${workflowRuns.runId} = ${clarificationRequests.runId}
            and ${stalledResumeRunSql()}
        )`,
      ),
    )
    .orderBy(asc(clarificationRequests.answeredAt));
  return rows.filter((row) => row.hookToken).map(mapHookRow);
}

/** Latest pending-or-answered hook clarification for a ticket whose asking run
 *  still holds the bound subject claim (i.e. is suspended and resumable). */
export async function getResumableClarificationForTicket(
  db: Db,
  ticketKey: string,
): Promise<HookClarificationRow | null> {
  const [row] = await db
    .select()
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.ticketKey, ticketKey),
        inArray(clarificationRequests.status, ["pending", "answered"]),
        isNotNull(clarificationRequests.hookToken),
        // The asking run must still hold its bound subject claim; a released
        // claim means the run is no longer suspended and cannot be resumed.
        sql`exists (
          select 1 from ${activeRuns}
          where ${activeRuns.subjectKey} = ${clarificationRequests.subjectKey}
            and ${activeRuns.runId} = ${clarificationRequests.runId}
            and ${activeRuns.state} = 'bound'
        )`,
      ),
    )
    .orderBy(desc(clarificationRequests.askedAt))
    .limit(1);
  return row?.hookToken ? mapHookRow(row) : null;
}

/** The same resumable clarification, addressed by the asking run instead of by its
 *  ticket. A run id is what a caller that watched a run park actually holds, and it
 *  is the only address that works for a ticketless subject (a pull request review
 *  parks on a clarification too, and `ticket_key` is null there, so the ticket-keyed
 *  lookup above can never find it).
 *
 *  Same bound-claim guard, for the same reason: a released claim means the run is no
 *  longer suspended, so nothing about it is answerable. Ordered by askedAt like its
 *  sibling, so a run that asked twice resolves to the current round. */
export async function getResumableClarificationForRun(
  db: Db,
  runId: string,
): Promise<HookClarificationRow | null> {
  const [row] = await db
    .select()
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.runId, runId),
        inArray(clarificationRequests.status, ["pending", "answered"]),
        isNotNull(clarificationRequests.hookToken),
        sql`exists (
          select 1 from ${activeRuns}
          where ${activeRuns.subjectKey} = ${clarificationRequests.subjectKey}
            and ${activeRuns.runId} = ${clarificationRequests.runId}
            and ${activeRuns.state} = 'bound'
        )`,
      ),
    )
    .orderBy(desc(clarificationRequests.askedAt))
    .limit(1);
  return row?.hookToken ? mapHookRow(row) : null;
}

export async function answerHookClarification(
  db: Db,
  id: string,
  answer: string,
  actor: { id: string; label: string },
): Promise<HookClarificationRow | null> {
  const [row] = await db
    .update(clarificationRequests)
    .set({
      status: "answered",
      answer,
      answeredById: actor.id,
      answeredByLabel: actor.label,
      answeredAt: new Date(),
    })
    .where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "pending")))
    .returning();
  return row ? mapHookRow(row) : null;
}

export async function markHookClarificationCleanup(
  db: Db,
  id: string,
  result: { status: "deleted" } | { status: "failed"; error: string },
): Promise<void> {
  await db
    .update(clarificationRequests)
    .set(
      result.status === "deleted"
        ? { cleanupState: "deleted", cleanupError: null }
        : { cleanupState: "failed", cleanupError: result.error.slice(0, 2000) },
    )
    .where(eq(clarificationRequests.id, id));
}

export async function supersedePreparingHookClarification(
  db: Db,
  id: string,
): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({ status: "superseded" })
    .where(
      and(
        eq(clarificationRequests.id, id),
        sql`${clarificationRequests.status} in ('preparing', 'pending')`,
      ),
    );
}
