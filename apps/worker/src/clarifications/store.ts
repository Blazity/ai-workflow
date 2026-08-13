import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { ClarificationRequest, ClarificationStatus } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { activeRuns, clarificationRequests } from "../db/schema.js";
import type { ActiveRunOwner } from "../lib/active-run-owner.js";
import { ActiveRunOwnerError } from "../lib/run-control-errors.js";
import { resolveAwaitingRunsForTicket } from "../lib/telemetry/run-telemetry.js";

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

/** One parked run whose ticket the poll can still verify in the tracker. */
export interface ParkedTicketClarification {
  ticketKey: string;
  subjectKey: string;
  runId: string;
  ticketMissingSince: Date | null;
}

/**
 * Parks that a deleted ticket would strand: an open question (`pending`, or
 * `answered` while the resume has not landed) whose run still holds a bound
 * claim, which is exactly the claim that occupies a concurrency slot. The same
 * shape as {@link classifyProtectedClarificationSubjects}, narrowed to rows that
 * name a ticket, because a ticketless `scope:any` continuation has no ticket
 * that can go missing.
 *
 * One entry per run, oldest round first: a run can carry several rounds of
 * questions and the retirement is per run, not per row.
 */
export async function listParkedTicketClarifications(
  db: Db,
): Promise<ParkedTicketClarification[]> {
  const rows = await db
    .select({
      ticketKey: clarificationRequests.ticketKey,
      subjectKey: clarificationRequests.subjectKey,
      runId: clarificationRequests.runId,
      ticketMissingSince: clarificationRequests.ticketMissingSince,
    })
    .from(clarificationRequests)
    .where(
      and(
        isNotNull(clarificationRequests.ticketKey),
        isNotNull(clarificationRequests.subjectKey),
        inArray(clarificationRequests.status, ["pending", "answered"]),
        sql`exists (
          select 1 from ${activeRuns}
          where ${activeRuns.subjectKey} = ${clarificationRequests.subjectKey}
            and ${activeRuns.runId} = ${clarificationRequests.runId}
            and ${activeRuns.state} = 'bound'
        )`,
      ),
    )
    .orderBy(asc(clarificationRequests.askedAt));

  const byRun = new Map<string, ParkedTicketClarification>();
  for (const row of rows) {
    if (!row.ticketKey || !row.subjectKey || byRun.has(row.runId)) continue;
    byRun.set(row.runId, {
      ticketKey: row.ticketKey,
      subjectKey: row.subjectKey,
      runId: row.runId,
      ticketMissingSince: row.ticketMissingSince,
    });
  }
  return [...byRun.values()];
}

/**
 * Record the first pass that could not find a park's ticket. Keyed on the run so
 * every round of the same park shares one clock, and only writes an unset
 * marker, so the recorded age is the age of the first absent reading and not of
 * the latest one.
 */
export async function markClarificationTicketMissing(
  db: Db,
  runId: string,
  observedAt: Date,
): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({ ticketMissingSince: observedAt })
    .where(
      and(
        eq(clarificationRequests.runId, runId),
        isNull(clarificationRequests.ticketMissingSince),
        inArray(clarificationRequests.status, ["pending", "answered"]),
      ),
    );
}

/** Forget the absence once the ticket reads back, so a tracker outage or a
 * revoked-then-restored permission never accumulates towards a retirement. */
export async function clearClarificationTicketMissing(
  db: Db,
  runId: string,
): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({ ticketMissingSince: null })
    .where(
      and(
        eq(clarificationRequests.runId, runId),
        isNotNull(clarificationRequests.ticketMissingSince),
      ),
    );
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
  // Only after the ownership gate above has confirmed this run is the exact
  // bound owner: a fresh pickup supersedes its parked predecessors, which stay
  // "awaiting" until something flips them.
  const resolvedAwaiting = await resolveAwaitingRunsForTicket(
    db,
    input.ticketKey,
    input.currentRunId,
  );
  return { superseded: Number(row?.superseded_count ?? 0), resolvedAwaiting };
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
