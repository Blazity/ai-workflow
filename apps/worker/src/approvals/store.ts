import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { ApprovalRequest, ApprovalStatus } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { approvalRequests } from "../db/schema.js";

export interface ApprovalRow {
  id: string;
  ticketKey: string;
  definitionId: number;
  /** Definition head version when the plan was filed; the pinned version.
   *  Null only for rows predating version pinning. */
  definitionVersion: number | null;
  runId: string;
  plan: { markdown: string };
  assumptions: string[] | null;
  status: ApprovalStatus;
  requestedAt: Date;
  requestedBy: string;
  decidedById: string | null;
  decidedByLabel: string | null;
  decidedAt: Date | null;
  dispatchedRunId: string | null;
}

/** Domain-level failure a write raises (409 conflict). Routes map statusCode onto
 *  the HTTP response; distinct from the 403 auth gate. */
export class ApprovalStoreError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type ApprovalSelect = typeof approvalRequests.$inferSelect;

function mapRow(row: ApprovalSelect): ApprovalRow {
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion ?? null,
    runId: row.runId,
    plan: row.plan,
    assumptions: row.assumptions ?? null,
    status: row.status as ApprovalStatus,
    requestedAt: row.requestedAt,
    requestedBy: row.requestedBy,
    decidedById: row.decidedById,
    decidedByLabel: row.decidedByLabel,
    decidedAt: row.decidedAt,
    dispatchedRunId: row.dispatchedRunId,
  };
}

/**
 * Inserts a fresh pending approval for a ticket, superseding any existing
 * pending one in the same transaction so the partial unique index
 * (one pending row per ticket) never trips. The id is generated app-side.
 */
export async function createApprovalRequest(
  db: Db,
  input: {
    ticketKey: string;
    definitionId: number;
    definitionVersion: number | null;
    runId: string;
    plan: { markdown: string };
    assumptions?: string[] | null;
    requestedBy?: string;
  },
): Promise<ApprovalRow> {
  // Production uses neon-http and cannot open an interactive transaction. A
  // single data-modifying CTE gives the supersede+insert replacement one
  // statement boundary: a definite insert failure rolls the old status back,
  // while the partial unique index still enforces one pending row per ticket.
  const id = randomUUID();
  const plan = JSON.stringify(input.plan);
  const assumptions =
    input.assumptions == null ? null : JSON.stringify(input.assumptions);
  const result = await db.execute(sql`
    with superseded as (
      update ${approvalRequests}
      set status = 'superseded'
      where ${approvalRequests.ticketKey} = ${input.ticketKey}
        and ${approvalRequests.status} = 'pending'
      returning ${approvalRequests.id}
    ), inserted as (
      insert into ${approvalRequests} (
        id,
        ticket_key,
        definition_id,
        definition_version,
        run_id,
        plan,
        assumptions,
        status,
        requested_by
      )
      select
        ${id},
        ${input.ticketKey},
        ${input.definitionId},
        ${input.definitionVersion},
        ${input.runId},
        ${plan}::jsonb,
        ${assumptions}::jsonb,
        'pending',
        ${input.requestedBy ?? "workflow"}
      from (select count(*) from superseded) as supersede_barrier
      returning *
    )
    select
      id,
      ticket_key as "ticketKey",
      definition_id as "definitionId",
      definition_version as "definitionVersion",
      run_id as "runId",
      plan,
      assumptions,
      status,
      requested_at as "requestedAt",
      requested_by as "requestedBy",
      decided_by_id as "decidedById",
      decided_by_label as "decidedByLabel",
      decided_at as "decidedAt",
      dispatched_run_id as "dispatchedRunId"
    from inserted
  `);
  const row = rawRows<ApprovalSelect>(result)[0];
  if (!row) throw new Error("approval request insert returned no row");
  return mapRow(row);
}

/** Newest first. `pending` (default) filters to open approvals; `all` returns every row. */
export async function listApprovals(
  db: Db,
  input: { status?: "pending" | "all" } = {},
): Promise<ApprovalRow[]> {
  const status = input.status ?? "pending";
  const rows =
    status === "pending"
      ? await db
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.status, "pending"))
          .orderBy(desc(approvalRequests.requestedAt))
      : await db.select().from(approvalRequests).orderBy(desc(approvalRequests.requestedAt));
  return rows.map(mapRow);
}

/**
 * Decisions that still own the ticket's next workflow path. Pending requests
 * must wait for a human; approved requests must start their pinned definition
 * before normal AI-column discovery may launch a replacement ticket run.
 */
export async function listDispatchBlockingApprovals(db: Db): Promise<ApprovalRow[]> {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      or(
        eq(approvalRequests.status, "pending"),
        and(
          eq(approvalRequests.status, "approved"),
          isNull(approvalRequests.dispatchedRunId),
        ),
      ),
    )
    .orderBy(desc(approvalRequests.requestedAt));
  return rows.map(mapRow);
}

export async function hasDispatchBlockingApprovalForTicket(
  db: Db,
  ticketKey: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.ticketKey, ticketKey),
        or(
          eq(approvalRequests.status, "pending"),
          and(
            eq(approvalRequests.status, "approved"),
            isNull(approvalRequests.dispatchedRunId),
          ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function getApproval(db: Db, id: string): Promise<ApprovalRow | null> {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Compare-and-set decision: transitions a pending row to approved/rejected.
 * Zero rows updated means it was already decided (or superseded) by a racer,
 * surfaced as ApprovalStoreError(409) so callers release any held claim.
 */
export async function decideApproval(
  db: Db,
  input: { id: string; decision: "approved" | "rejected"; actor: { id: string; label: string } },
): Promise<ApprovalRow> {
  const rows = await db
    .update(approvalRequests)
    .set({
      status: input.decision,
      decidedById: input.actor.id,
      decidedByLabel: input.actor.label,
      decidedAt: new Date(),
    })
    .where(and(eq(approvalRequests.id, input.id), eq(approvalRequests.status, "pending")))
    .returning();
  const row = rows[0];
  if (!row) {
    throw new ApprovalStoreError(409, "already_decided");
  }
  return mapRow(row);
}

/** System-only terminal transition for a pending request that cannot be
 * decided. An approved human decision is final and is never eligible. */
export async function rejectUndispatchableApproval(db: Db, id: string): Promise<ApprovalRow> {
  const rows = await db
    .update(approvalRequests)
    .set({
      status: "rejected",
      decidedById: "system",
      decidedByLabel: "system",
      decidedAt: new Date(),
    })
    .where(
      and(
        eq(approvalRequests.id, id),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) {
    throw new ApprovalStoreError(409, "already_decided");
  }
  return mapRow(row);
}

/**
 * Terminal cancellation cleanup for a plan produced by an exact workflow run.
 * A late step may create the request after cancellation's initial barrier, so
 * cancellation may still retire the exact pending row. Human approval is the
 * competing final CAS: once it wins, cancellation cannot revoke it and the
 * pinned continuation remains protected for recovery.
 */
export async function retireApprovalCancellation(
  db: Db,
  input: { ticketKey: string; runId: string },
): Promise<number> {
  const rows = await db
    .update(approvalRequests)
    .set({ status: "superseded" })
    .where(
      and(
        eq(approvalRequests.ticketKey, input.ticketKey),
        eq(approvalRequests.runId, input.runId),
        isNull(approvalRequests.dispatchedRunId),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .returning({ id: approvalRequests.id });
  return rows.length;
}

export async function setDispatchedRunId(db: Db, id: string, runId: string): Promise<void> {
  const rows = await db
    .update(approvalRequests)
    .set({ dispatchedRunId: runId })
    .where(
      and(
        eq(approvalRequests.id, id),
        eq(approvalRequests.status, "approved"),
        or(
          isNull(approvalRequests.dispatchedRunId),
          eq(approvalRequests.dispatchedRunId, runId),
        ),
      ),
    )
    .returning({ id: approvalRequests.id });
  if (rows.length === 0) {
    throw new ApprovalStoreError(409, "dispatch_already_recorded");
  }
}

export function serializeApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    runId: row.runId,
    plan: row.plan,
    assumptions: row.assumptions,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    requestedBy: row.requestedBy,
    decidedById: row.decidedById,
    decidedByLabel: row.decidedByLabel,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    dispatchedRunId: row.dispatchedRunId,
  };
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
