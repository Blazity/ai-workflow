import { and, eq, gt, or, sql } from "drizzle-orm";
import type { IssueTrackerMoveTarget } from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import { activeRuns, ticketTransitionIntents } from "../db/schema.js";

const DEFAULT_INTENT_TTL_MS = 5 * 60 * 1000;

interface RecordIntentInput {
  ticketKey: string;
  subjectKey: string;
  ownerToken: string;
  runId: string;
  target: IssueTrackerMoveTarget;
  ttlMs?: number;
}

export async function recordTicketTransitionIntent(
  db: Db,
  input: RecordIntentInput,
): Promise<number> {
  await deleteExpiredIntents(db);
  const owner = await db
    .select({ runId: activeRuns.runId })
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.subjectKey, input.subjectKey),
        eq(activeRuns.ownerToken, input.ownerToken),
        eq(activeRuns.state, "bound"),
        eq(activeRuns.runId, input.runId),
      ),
    )
    .limit(1);
  if (!owner[0]) {
    throw new Error("Cannot record ticket transition intent without the bound run owner.");
  }

  const target = normalizeTarget(input.target);
  const rows = await db
    .insert(ticketTransitionIntents)
    .values({
      ticketKey: input.ticketKey,
      subjectKey: input.subjectKey,
      ownerToken: input.ownerToken,
      runId: input.runId,
      targetStatusId: target.statusId,
      targetStatusName: target.name,
      expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_INTENT_TTL_MS)),
    })
    .returning({ id: ticketTransitionIntents.id });
  if (!rows[0]) throw new Error("Ticket transition intent was not persisted.");
  return rows[0].id;
}

export async function consumeTicketTransitionIntent(
  db: Db,
  ticketKey: string,
  status: { id?: string | null; name?: string | null },
): Promise<boolean> {
  await deleteExpiredIntents(db);
  const statusId = status.id?.trim() ?? "";
  const statusName = status.name?.trim() ?? "";
  if (!statusId && !statusName) return false;

  const matches = [];
  if (statusId) matches.push(eq(ticketTransitionIntents.targetStatusId, statusId));
  if (statusName) {
    matches.push(
      sql`lower(${ticketTransitionIntents.targetStatusName}) = lower(${statusName})`,
    );
  }

  const rows = await db
    .select({ id: ticketTransitionIntents.id })
    .from(ticketTransitionIntents)
    .innerJoin(
      activeRuns,
      and(
        eq(activeRuns.subjectKey, ticketTransitionIntents.subjectKey),
        eq(activeRuns.ownerToken, ticketTransitionIntents.ownerToken),
        eq(activeRuns.runId, ticketTransitionIntents.runId),
        eq(activeRuns.state, "bound"),
      ),
    )
    .where(
      and(
        eq(ticketTransitionIntents.ticketKey, ticketKey),
        gt(ticketTransitionIntents.expiresAt, new Date()),
        or(...matches),
      ),
    )
    .limit(1);
  if (!rows[0]) return false;

  await db
    .update(ticketTransitionIntents)
    .set({ consumedAt: sql`coalesce(${ticketTransitionIntents.consumedAt}, now())` })
    .where(eq(ticketTransitionIntents.id, rows[0].id));
  return true;
}

export async function discardTicketTransitionIntent(db: Db, id: number): Promise<void> {
  await db.delete(ticketTransitionIntents).where(eq(ticketTransitionIntents.id, id));
}

async function deleteExpiredIntents(db: Db): Promise<void> {
  await db
    .delete(ticketTransitionIntents)
    .where(sql`${ticketTransitionIntents.expiresAt} <= now()`);
}

function normalizeTarget(target: IssueTrackerMoveTarget): {
  name: string;
  statusId: string | null;
} {
  if (typeof target === "string") return { name: target, statusId: null };
  return { name: target.name, statusId: target.statusId ?? null };
}
