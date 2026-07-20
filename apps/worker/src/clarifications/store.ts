import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { ClarificationRequest, ClarificationStatus } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { activeRuns, clarificationRequests } from "../db/schema.js";
import type { ActiveRunOwner } from "../lib/active-run-owner.js";
import { ActiveRunOwnerError } from "../lib/run-control-errors.js";

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

/** Test/backfill helper for legacy callers; runtime creation uses hook-store directly. */
export async function createClarificationRequest(
  db: Db,
  input: {
    ticketKey: string;
    runId: string;
    blockId?: string | null;
    definitionId?: number | null;
    definitionVersion?: number | null;
    questions: string[];
    suggestedAnswers?: string[] | null;
  },
): Promise<ClarificationRow> {
  const { prepareHookClarification, publishHookClarification } = await import(
    "./hook-store.js"
  );
  const prepared = await prepareHookClarification(db, {
    ticketKey: input.ticketKey,
    subjectKey: `ticket:jira:${input.ticketKey}`,
    runId: input.runId,
    blockId: input.blockId ?? "human_question",
    definitionId: input.definitionId ?? null,
    definitionVersion: input.definitionVersion ?? null,
    questions: input.questions,
    suggestedAnswers: input.suggestedAnswers,
  });
  await publishHookClarification(db, prepared.id);
  const row = await getClarification(db, prepared.id);
  if (!row) throw new Error("failed to publish clarification");
  return row;
}

export async function getClarification(db: Db, id: string): Promise<ClarificationRow | null> {
  const [row] = await db
    .select()
    .from(clarificationRequests)
    .where(eq(clarificationRequests.id, id))
    .limit(1);
  return row ? mapRow(row) : null;
}

export async function getClarificationForRun(
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

export async function listAnsweredForTicket(
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

/** Protect the same asking run while its ticket is parked outside the AI column. */
export async function classifyProtectedClarificationSubjects(
  db: Db,
): Promise<ProtectedClarificationSubjects> {
  const rows = await db
    .select({ subjectKey: clarificationRequests.subjectKey })
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
  const retained = [...new Set(rows.flatMap((row) => row.subjectKey ? [row.subjectKey] : []))]
    .sort();
  return { all: retained, retained, terminal: [] };
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
): Promise<{ superseded: number; resolvedAwaiting: 0 }> {
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
    )
    SELECT
      (SELECT count(*)::integer FROM exact_owner) AS owner_count,
      (SELECT count(*)::integer FROM superseded) AS superseded_count
  `);
  const row = ((result as { rows?: Array<{ owner_count: number; superseded_count: number }> }).rows ?? [])[0];
  if (Number(row?.owner_count ?? 0) !== 1) {
    throw new ActiveRunOwnerError(
      "Cannot reconcile clarification pickup without the exact bound owner.",
    );
  }
  return { superseded: Number(row?.superseded_count ?? 0), resolvedAwaiting: 0 };
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
