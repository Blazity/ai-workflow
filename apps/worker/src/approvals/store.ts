import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
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
  // neon-http (loaded inside the WDK step that runs this block) has no interactive
  // transactions. Supersede the current pending row, then insert the new one; the
  // partial unique index (one pending row per ticket) still guarantees a single
  // open approval. If the insert fails, the run fails and re-runs a fresh request.
  await db
    .update(approvalRequests)
    .set({ status: "superseded" })
    .where(
      and(
        eq(approvalRequests.ticketKey, input.ticketKey),
        eq(approvalRequests.status, "pending"),
      ),
    );
  const rows = await db
    .insert(approvalRequests)
    .values({
      id: randomUUID(),
      ticketKey: input.ticketKey,
      definitionId: input.definitionId,
      definitionVersion: input.definitionVersion,
      runId: input.runId,
      plan: input.plan,
      assumptions: input.assumptions ?? null,
      requestedBy: input.requestedBy ?? "workflow",
    })
    .returning();
  return mapRow(rows[0]!);
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

export async function setDispatchedRunId(db: Db, id: string, runId: string): Promise<void> {
  const rows = await db
    .update(approvalRequests)
    .set({ dispatchedRunId: runId })
    .where(
      and(
        eq(approvalRequests.id, id),
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
