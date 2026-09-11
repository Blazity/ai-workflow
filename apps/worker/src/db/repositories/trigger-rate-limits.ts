import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../client.js";
import type { Db } from "../types.js";
import { triggerRateLimits, triggerRejectionCounters } from "../schema.js";

type TriggerRateLimitKey = { definitionId: string; nodeId: string };

export async function consumeTriggerRateLimit(
  db: Db,
  input: TriggerRateLimitKey & {
    windowKind: "minute" | "hour" | "day" | "month";
    windowStart: Date;
  },
): Promise<number> {
  const rows = await db
    .insert(triggerRateLimits)
    .values({ ...input, count: 1 })
    .onConflictDoUpdate({
      target: [
        triggerRateLimits.definitionId,
        triggerRateLimits.nodeId,
        triggerRateLimits.windowKind,
        triggerRateLimits.windowStart,
      ],
      set: { count: sql`${triggerRateLimits.count} + 1` },
    })
    .returning({ count: triggerRateLimits.count });
  return rows[0]?.count ?? 1;
}

export async function incrementTriggerRejectionCounter(
  db: Db,
  input: TriggerRateLimitKey & { reason: string; day: string },
): Promise<void> {
  await db
    .insert(triggerRejectionCounters)
    .values({ ...input, count: 1 })
    .onConflictDoUpdate({
      target: [
        triggerRejectionCounters.definitionId,
        triggerRejectionCounters.nodeId,
        triggerRejectionCounters.day,
        triggerRejectionCounters.reason,
      ],
      set: { count: sql`${triggerRejectionCounters.count} + 1` },
    });
}

export function consumeConnectedTriggerRateLimit(
  input: Parameters<typeof consumeTriggerRateLimit>[1],
) {
  return consumeTriggerRateLimit(getDb(), input);
}

export function incrementConnectedTriggerRejectionCounter(
  input: Parameters<typeof incrementTriggerRejectionCounter>[1],
) {
  return incrementTriggerRejectionCounter(getDb(), input);
}

export async function listTriggerRejectionCounters(
  db: Db,
  input: TriggerRateLimitKey & { day: string },
): Promise<Array<{ reason: string; count: number }>> {
  return db
    .select({ reason: triggerRejectionCounters.reason, count: triggerRejectionCounters.count })
    .from(triggerRejectionCounters)
    .where(
      and(
        eq(triggerRejectionCounters.definitionId, input.definitionId),
        eq(triggerRejectionCounters.nodeId, input.nodeId),
        eq(triggerRejectionCounters.day, input.day),
      ),
    )
    .orderBy(desc(triggerRejectionCounters.count));
}

export function listConnectedTriggerRejectionCounters(
  input: Parameters<typeof listTriggerRejectionCounters>[1],
) {
  return listTriggerRejectionCounters(getDb(), input);
}

export async function sweepExpiredTriggerRateLimits(db: Db, cutoff: Date): Promise<void> {
  await db.delete(triggerRateLimits).where(lt(triggerRateLimits.windowStart, cutoff));
}

export function sweepConnectedExpiredTriggerRateLimits(cutoff: Date): Promise<void> {
  return sweepExpiredTriggerRateLimits(getDb(), cutoff);
}

export async function sweepExpiredTriggerRejectionCounters(db: Db, cutoff: string): Promise<void> {
  await db.delete(triggerRejectionCounters).where(lt(triggerRejectionCounters.day, cutoff));
}

export function sweepConnectedExpiredTriggerRejectionCounters(cutoff: string): Promise<void> {
  return sweepExpiredTriggerRejectionCounters(getDb(), cutoff);
}
