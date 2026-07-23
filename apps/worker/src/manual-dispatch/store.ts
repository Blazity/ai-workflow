import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { manualDispatchRequests } from "../db/schema.js";

export type ManualDispatchStatus =
  | "pending"
  | "reserved"
  | "prepared"
  | "candidate_started"
  | "started"
  | "failed";

export interface ManualDispatchRow {
  requestId: string;
  payloadHash: string;
  definitionId: number;
  definitionVersion: number;
  triggerNodeId: string;
  triggerType: string;
  inputKind: "ticket" | "pull_request";
  subjectKey: string;
  ticketKey: string | null;
  inputPayload: Record<string, unknown>;
  actorUserId: string;
  actorLabel: string;
  ownerToken: string | null;
  runId: string | null;
  status: ManualDispatchStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function createManualDispatchRequest(
  db: Db,
  input: Omit<
    ManualDispatchRow,
    | "ownerToken"
    | "runId"
    | "status"
    | "errorCode"
    | "errorMessage"
    | "createdAt"
    | "updatedAt"
  >,
): Promise<{ inserted: boolean; row: ManualDispatchRow }> {
  const inserted = await db
    .insert(manualDispatchRequests)
    .values(input)
    .onConflictDoNothing({ target: manualDispatchRequests.requestId })
    .returning();
  if (inserted[0]) return { inserted: true, row: mapRow(inserted[0]) };
  const existing = await getManualDispatchRequest(db, input.requestId);
  if (!existing) throw new Error(`Manual dispatch ${input.requestId} disappeared after conflict`);
  return { inserted: false, row: existing };
}

export async function getManualDispatchRequest(
  db: Db,
  requestId: string,
): Promise<ManualDispatchRow | null> {
  const rows = await db
    .select()
    .from(manualDispatchRequests)
    .where(eq(manualDispatchRequests.requestId, requestId))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function reserveManualDispatchRequest(
  db: Db,
  requestId: string,
  ownerToken: string,
): Promise<boolean> {
  const rows = await db
    .update(manualDispatchRequests)
    .set({
      ownerToken,
      status: "reserved",
      errorCode: null,
      errorMessage: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(manualDispatchRequests.requestId, requestId),
        eq(manualDispatchRequests.status, "pending"),
        isNull(manualDispatchRequests.ownerToken),
      ),
    )
    .returning({ requestId: manualDispatchRequests.requestId });
  return rows.length === 1;
}

export async function markManualDispatchPrepared(
  db: Db,
  requestId: string,
  ownerToken: string,
  inputPayload?: Record<string, unknown>,
): Promise<boolean> {
  const rows = await db
    .update(manualDispatchRequests)
    .set({
      status: "prepared",
      ...(inputPayload ? { inputPayload } : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(manualDispatchRequests.requestId, requestId),
        eq(manualDispatchRequests.ownerToken, ownerToken),
        inArray(manualDispatchRequests.status, [
          "reserved",
          "prepared",
          "candidate_started",
        ]),
      ),
    )
    .returning({ requestId: manualDispatchRequests.requestId });
  return rows.length === 1;
}

export async function markManualDispatchCandidateStarted(
  db: Db,
  requestId: string,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .update(manualDispatchRequests)
    .set({ status: "candidate_started", runId, updatedAt: sql`now()` })
    .where(
      and(
        eq(manualDispatchRequests.requestId, requestId),
        eq(manualDispatchRequests.ownerToken, ownerToken),
        inArray(manualDispatchRequests.status, [
          "reserved",
          "prepared",
          "candidate_started",
        ]),
      ),
    )
    .returning({ requestId: manualDispatchRequests.requestId });
  return rows.length === 1;
}

export async function acknowledgeManualDispatchStarted(
  db: Db,
  requestId: string,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .update(manualDispatchRequests)
    .set({
      status: "started",
      runId,
      errorCode: null,
      errorMessage: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(manualDispatchRequests.requestId, requestId),
        eq(manualDispatchRequests.ownerToken, ownerToken),
        inArray(manualDispatchRequests.status, [
          "reserved",
          "prepared",
          "candidate_started",
          "started",
        ]),
      ),
    )
    .returning({ requestId: manualDispatchRequests.requestId });
  return rows.length === 1;
}

export async function markManualDispatchFailed(
  db: Db,
  requestId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await db
    .update(manualDispatchRequests)
    .set({
      status: "failed",
      errorCode,
      errorMessage,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(manualDispatchRequests.requestId, requestId),
        inArray(manualDispatchRequests.status, [
          "pending",
          "reserved",
          "prepared",
          "candidate_started",
        ]),
      ),
    );
}

export async function resetManualDispatchToPending(
  db: Db,
  requestId: string,
  ownerToken: string,
): Promise<boolean> {
  const rows = await db
    .update(manualDispatchRequests)
    .set({
      status: "pending",
      ownerToken: null,
      runId: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(manualDispatchRequests.requestId, requestId),
        eq(manualDispatchRequests.ownerToken, ownerToken),
        inArray(manualDispatchRequests.status, [
          "reserved",
          "prepared",
          "candidate_started",
        ]),
      ),
    )
    .returning({ requestId: manualDispatchRequests.requestId });
  return rows.length === 1;
}

export async function listRecoverableManualDispatches(
  db: Db,
  limit = 25,
): Promise<ManualDispatchRow[]> {
  const rows = await db
    .select()
    .from(manualDispatchRequests)
    .where(
      inArray(manualDispatchRequests.status, [
        "pending",
        "reserved",
        "prepared",
        "candidate_started",
      ]),
    )
    .orderBy(manualDispatchRequests.createdAt)
    .limit(limit);
  return rows.map(mapRow);
}

function mapRow(
  row: typeof manualDispatchRequests.$inferSelect,
): ManualDispatchRow {
  return {
    ...row,
    inputKind: row.inputKind as ManualDispatchRow["inputKind"],
    inputPayload: row.inputPayload as Record<string, unknown>,
    status: row.status as ManualDispatchStatus,
  };
}
