import { and, asc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { dispatchCapacityQueue } from "../schema.js";

export interface QueuedDispatchTicketRow {
  ticketKey: string;
  queuedAt: Date;
}

export function listQueuedDispatchTickets(db: Db): Promise<QueuedDispatchTicketRow[]> {
  return db
    .select({
      ticketKey: dispatchCapacityQueue.ticketKey,
      queuedAt: dispatchCapacityQueue.queuedAt,
    })
    .from(dispatchCapacityQueue)
    .orderBy(asc(dispatchCapacityQueue.queuedAt));
}

export function listConnectedQueuedDispatchTickets() {
  return listQueuedDispatchTickets(getDb());
}

export async function ensureQueuedDispatchTicket(db: Db, ticketKey: string): Promise<void> {
  await db.insert(dispatchCapacityQueue).values({ ticketKey }).onConflictDoNothing();
}

export function ensureConnectedQueuedDispatchTicket(ticketKey: string): Promise<void> {
  return ensureQueuedDispatchTicket(getDb(), ticketKey);
}

export async function deleteQueuedDispatchTickets(
  db: Db,
  ticketKeys: readonly string[],
): Promise<number> {
  if (ticketKeys.length === 0) return 0;
  const rows = await db
    .delete(dispatchCapacityQueue)
    .where(inArray(dispatchCapacityQueue.ticketKey, [...ticketKeys]))
    .returning({ ticketKey: dispatchCapacityQueue.ticketKey });
  return rows.length;
}

export function deleteConnectedQueuedDispatchTickets(ticketKeys: readonly string[]) {
  return deleteQueuedDispatchTickets(getDb(), ticketKeys);
}

export async function reconcileQueuedDispatchTickets(
  db: Db,
  currentTicketKeys: readonly string[],
): Promise<number> {
  if (currentTicketKeys.length === 0) return 0;
  const rows = await db
    .delete(dispatchCapacityQueue)
    .where(notInArray(dispatchCapacityQueue.ticketKey, [...currentTicketKeys]))
    .returning({ ticketKey: dispatchCapacityQueue.ticketKey });
  return rows.length;
}

export function reconcileConnectedQueuedDispatchTickets(currentTicketKeys: readonly string[]) {
  return reconcileQueuedDispatchTickets(getDb(), currentTicketKeys);
}

export async function listUnconfirmedQueuedDispatchTickets(
  db: Db,
  ticketKeys: readonly string[],
  limit: number,
): Promise<string[]> {
  if (ticketKeys.length === 0) return [];
  const rows = await db
    .select({ ticketKey: dispatchCapacityQueue.ticketKey })
    .from(dispatchCapacityQueue)
    .where(
      and(
        isNull(dispatchCapacityQueue.confirmedAt),
        inArray(dispatchCapacityQueue.ticketKey, [...ticketKeys]),
      ),
    )
    .orderBy(asc(dispatchCapacityQueue.queuedAt))
    .limit(limit);
  return rows.map((row) => row.ticketKey);
}

export function listConnectedUnconfirmedQueuedDispatchTickets(
  ticketKeys: readonly string[],
  limit: number,
) {
  return listUnconfirmedQueuedDispatchTickets(getDb(), ticketKeys, limit);
}

export async function claimQueuedDispatchTicketComment(
  db: Db,
  ticketKey: string,
  leaseMs: number,
): Promise<boolean> {
  const rows = await db
    .update(dispatchCapacityQueue)
    .set({ attemptedAt: sql`now()` })
    .where(
      and(
        eq(dispatchCapacityQueue.ticketKey, ticketKey),
        isNull(dispatchCapacityQueue.confirmedAt),
        or(
          isNull(dispatchCapacityQueue.attemptedAt),
          lt(
            dispatchCapacityQueue.attemptedAt,
            sql`now() - (${leaseMs} * interval '1 millisecond')`,
          ),
        ),
      ),
    )
    .returning({ ticketKey: dispatchCapacityQueue.ticketKey });
  return rows.length > 0;
}

export function claimConnectedQueuedDispatchTicketComment(ticketKey: string, leaseMs: number) {
  return claimQueuedDispatchTicketComment(getDb(), ticketKey, leaseMs);
}

export async function confirmQueuedDispatchTicketComment(
  db: Db,
  ticketKey: string,
): Promise<void> {
  await db
    .update(dispatchCapacityQueue)
    .set({ confirmedAt: sql`now()` })
    .where(eq(dispatchCapacityQueue.ticketKey, ticketKey));
}

export function confirmConnectedQueuedDispatchTicketComment(ticketKey: string): Promise<void> {
  return confirmQueuedDispatchTicketComment(getDb(), ticketKey);
}
