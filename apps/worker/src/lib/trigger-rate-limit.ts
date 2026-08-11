import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { triggerRateLimits, triggerRejectionCounters } from "../db/schema.js";

export type TriggerRateLimitWindow = "minute" | "hour" | "day" | "month";

export interface TriggerRateLimitKey {
  definitionId: string;
  nodeId: string;
}

export interface TriggerRateLimitConfig {
  max: number;
  windowKind: TriggerRateLimitWindow;
}

/** The optional node parameters, as authored on a trigger node. */
export interface TriggerRateLimitNodeParams {
  rateLimitMax?: number;
  rateLimitWindow?: TriggerRateLimitWindow;
}

const WINDOW_MS: Record<Exclude<TriggerRateLimitWindow, "month">, number> = {
  minute: 60_000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

/** Fixed windows on the UTC clock. Minute/hour/day floor the epoch (which is
 * UTC); a month is the calendar month, so the 31st at 23:00 and the 1st at
 * 00:30 are different windows even though they are 90 minutes apart. */
export function triggerRateWindowStart(windowKind: TriggerRateLimitWindow, now: Date): Date {
  if (windowKind === "month") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  const windowMs = WINDOW_MS[windowKind];
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Count this start and answer whether it may proceed. The window start is part
 * of the primary key, so one upsert is the entire fixed-window algorithm: a
 * new window inserts a fresh row instead of needing a reset, and concurrent
 * starts serialize on the row rather than on a read-then-write.
 *
 * Deliberately counts the refused starts too: a trigger that keeps firing past
 * its limit stays limited for the rest of the window.
 */
export async function checkAndIncrementTriggerRate(
  db: Db,
  key: TriggerRateLimitKey,
  windowKind: TriggerRateLimitWindow,
  max: number,
  now: Date,
): Promise<{ allowed: boolean; count: number }> {
  const rows = await db
    .insert(triggerRateLimits)
    .values({
      definitionId: key.definitionId,
      nodeId: key.nodeId,
      windowStart: triggerRateWindowStart(windowKind, now),
      count: 1,
    })
    .onConflictDoUpdate({
      target: [triggerRateLimits.definitionId, triggerRateLimits.nodeId, triggerRateLimits.windowStart],
      set: { count: sql`${triggerRateLimits.count} + 1` },
    })
    .returning({ count: triggerRateLimits.count });
  const count = rows[0]?.count ?? 1;
  return { allowed: count <= max, count };
}

/**
 * Merge a node's own rate-limit parameters with the env default, field by
 * field: the env value is a default, never a ceiling, so a node value always
 * wins. Returns null when no complete configuration results — unlimited, in
 * which case the caller must not write to trigger_rate_limits at all.
 */
export function resolveTriggerRateLimit(
  nodeParams: TriggerRateLimitNodeParams | undefined,
  envDefault: TriggerRateLimitConfig | null | undefined,
): TriggerRateLimitConfig | null {
  const max = nodeParams?.rateLimitMax ?? envDefault?.max;
  const windowKind = nodeParams?.rateLimitWindow ?? envDefault?.windowKind;
  if (max === undefined || windowKind === undefined) return null;
  return { max, windowKind };
}

/** A sibling trigger node as the dispatcher sees it: its id plus the params
 * authored on it. */
export interface TriggerRateLimitNode {
  nodeId: string;
  params: TriggerRateLimitNodeParams | undefined;
}

export interface RestrictiveTriggerRateLimit extends TriggerRateLimitConfig {
  /** The node the winning configuration came from, so the dispatcher knows
   * which node_id to count under. Null when no node contributed any field and
   * the config is purely the env default. */
  nodeId: string | null;
}

/**
 * Resolve one limit for several sibling nodes of the same trigger type, for
 * dispatchers that know the type but not the firing node: the smallest max
 * (the most restrictive configured limit) wins, and the result names the node
 * it came from.
 */
export function resolveRestrictiveTriggerRateLimit(
  nodes: readonly TriggerRateLimitNode[],
  envDefault: TriggerRateLimitConfig | null | undefined,
): RestrictiveTriggerRateLimit | null {
  let best: RestrictiveTriggerRateLimit | null = null;
  for (const node of nodes) {
    const resolved = resolveTriggerRateLimit(node.params, envDefault);
    if (resolved === null) continue;
    const configured =
      node.params?.rateLimitMax !== undefined || node.params?.rateLimitWindow !== undefined;
    if (best === null || resolved.max < best.max) {
      best = { ...resolved, nodeId: configured ? node.nodeId : null };
    }
  }
  return best;
}

function rejectionDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Tally one start refused by a trigger rate limit. A rejected start writes no
 * run row, so this counter is the only trace a saturated trigger leaves
 * behind.
 */
export async function recordTriggerRejection(
  db: Db,
  key: TriggerRateLimitKey,
  reason: string,
  now: Date,
): Promise<void> {
  await db
    .insert(triggerRejectionCounters)
    .values({
      definitionId: key.definitionId,
      nodeId: key.nodeId,
      reason,
      day: rejectionDay(now),
      count: 1,
    })
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

/** Today's refusals for one node grouped by reason, worst first. */
export async function getTriggerRejectionsToday(
  db: Db,
  key: TriggerRateLimitKey,
  now: Date,
): Promise<{ reason: string; count: number }[]> {
  return db
    .select({
      reason: triggerRejectionCounters.reason,
      count: triggerRejectionCounters.count,
    })
    .from(triggerRejectionCounters)
    .where(
      and(
        eq(triggerRejectionCounters.definitionId, key.definitionId),
        eq(triggerRejectionCounters.nodeId, key.nodeId),
        eq(triggerRejectionCounters.day, rejectionDay(now)),
      ),
    )
    .orderBy(desc(triggerRejectionCounters.count));
}

/** Safely above the longest live window (a calendar month plus its longest
 *  possible predecessor read), so no window anyone can still count into is
 *  ever deleted. */
const RATE_LIMIT_RETENTION_MS = 62 * 24 * 60 * 60 * 1000;

/** Long enough to see a pattern, short enough that the table stays small. */
const REJECTION_RETENTION_DAYS = 30;

/** Housekeeping for windows nothing can read again. */
export async function sweepTriggerRateLimits(db: Db, now: Date): Promise<void> {
  await db
    .delete(triggerRateLimits)
    .where(
      lt(triggerRateLimits.windowStart, new Date(now.getTime() - RATE_LIMIT_RETENTION_MS)),
    );
}

/** Housekeeping for rejection days nothing surfaces anymore. The day column
 *  is an ISO date string, so the cutoff compares lexicographically. */
export async function sweepTriggerRejectionCounters(db: Db, now: Date): Promise<void> {
  const cutoff = rejectionDay(new Date(now.getTime() - REJECTION_RETENTION_DAYS * 24 * 60 * 60 * 1000));
  await db.delete(triggerRejectionCounters).where(lt(triggerRejectionCounters.day, cutoff));
}
