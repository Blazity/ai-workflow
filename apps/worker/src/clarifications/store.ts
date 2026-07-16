import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { ClarificationRequest, ClarificationStatus } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { clarificationRequests } from "../db/schema.js";

export interface ClarificationRow {
  id: string;
  ticketKey: string;
  runId: string;
  blockId: string | null;
  definitionId: number | null;
  definitionVersion: number | null;
  questions: string[];
  suggestedAnswers: string[] | null;
  status: ClarificationStatus;
  askedAt: Date;
  answer: string | null;
  answeredById: string | null;
  answeredByLabel: string | null;
  answeredAt: Date | null;
  dispatchedRunId: string | null;
}

/** Domain-level failure a write raises (409 conflict). Routes map statusCode onto
 *  the HTTP response; distinct from the 403 auth gate. */
export class ClarificationStoreError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type ClarificationSelect = typeof clarificationRequests.$inferSelect;

function mapRow(row: ClarificationSelect): ClarificationRow {
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    runId: row.runId,
    blockId: row.blockId ?? null,
    definitionId: row.definitionId ?? null,
    definitionVersion: row.definitionVersion ?? null,
    questions: row.questions,
    suggestedAnswers: row.suggestedAnswers ?? null,
    status: row.status as ClarificationStatus,
    askedAt: row.askedAt,
    answer: row.answer,
    answeredById: row.answeredById,
    answeredByLabel: row.answeredByLabel,
    answeredAt: row.answeredAt,
    dispatchedRunId: row.dispatchedRunId,
  };
}

/**
 * Inserts a fresh pending clarification for a ticket, superseding any existing
 * pending one for the same ticket so the partial unique index (one pending row
 * per ticket) never trips. The id is generated app-side.
 */
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
  // neon-http (loaded inside the WDK step that runs this block) has no interactive
  // transactions. Supersede the current pending row, then insert the new one; the
  // partial unique index (one pending row per ticket) still guarantees a single
  // open clarification. If the insert fails, the run fails and re-runs a fresh ask.
  await db
    .update(clarificationRequests)
    .set({ status: "superseded" })
    .where(
      and(
        eq(clarificationRequests.ticketKey, input.ticketKey),
        eq(clarificationRequests.status, "pending"),
      ),
    );
  const rows = await db
    .insert(clarificationRequests)
    .values({
      id: randomUUID(),
      ticketKey: input.ticketKey,
      runId: input.runId,
      blockId: input.blockId ?? null,
      definitionId: input.definitionId ?? null,
      definitionVersion: input.definitionVersion ?? null,
      questions: input.questions,
      suggestedAnswers: input.suggestedAnswers ?? null,
    })
    .returning();
  return mapRow(rows[0]!);
}

export async function getClarification(db: Db, id: string): Promise<ClarificationRow | null> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(eq(clarificationRequests.id, id))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Latest clarification for a run (newest ask first); null when the run asked nothing. */
export async function getClarificationForRun(
  db: Db,
  runId: string,
): Promise<ClarificationRow | null> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(eq(clarificationRequests.runId, runId))
    .orderBy(desc(clarificationRequests.askedAt))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getPendingForTicket(
  db: Db,
  ticketKey: string,
): Promise<ClarificationRow | null> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.ticketKey, ticketKey),
        eq(clarificationRequests.status, "pending"),
      ),
    )
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Answered Q&A history for a ticket, oldest first; injected into resume prompts. */
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

/**
 * Compare-and-set answer: transitions a pending row to answered. Zero rows
 * updated means it was already answered (or superseded) by a racer, surfaced as
 * ClarificationStoreError(409) so callers release any held claim.
 */
export async function answerClarification(
  db: Db,
  input: { id: string; answer: string; actor: { id: string; label: string } },
): Promise<ClarificationRow> {
  const rows = await db
    .update(clarificationRequests)
    .set({
      status: "answered",
      answer: input.answer,
      answeredById: input.actor.id,
      answeredByLabel: input.actor.label,
      answeredAt: new Date(),
    })
    .where(
      and(eq(clarificationRequests.id, input.id), eq(clarificationRequests.status, "pending")),
    )
    .returning();
  const row = rows[0];
  if (!row) {
    throw new ClarificationStoreError(409, "already_answered");
  }
  return mapRow(row);
}

/** Supersedes any pending clarification for a ticket; returns the number superseded. */
export async function supersedePendingForTicket(db: Db, ticketKey: string): Promise<number> {
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

export async function setDispatchedRunId(db: Db, id: string, runId: string): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({ dispatchedRunId: runId })
    .where(eq(clarificationRequests.id, id));
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
    answeredAt: row.answeredAt ? row.answeredAt.toISOString() : null,
    dispatchedRunId: row.dispatchedRunId,
  };
}
