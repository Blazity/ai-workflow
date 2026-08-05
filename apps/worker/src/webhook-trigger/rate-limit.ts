import { lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { webhookTriggerRateLimits } from "../db/schema.js";

/** Authenticated deliveries one endpoint may accept per minute before it starts
 *  refusing. High enough that a normal integration never notices, low enough
 *  that a looping sender cannot fill the delivery inbox. Charged only after a
 *  valid signature, so junk can never spend it. */
export const DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;

/** Requests, verified or not, one endpoint absorbs per minute before it refuses
 *  before authentication. Far above the inbox budget so a real sender is never
 *  touched by it, but bounded so a URL holder flooding junk cannot burn
 *  unbounded decrypt and HMAC work. */
export const WEBHOOK_INGRESS_LIMIT_PER_MINUTE = 600;

/** The two independent budgets a request can spend, keyed apart in the counter
 *  so unauthenticated traffic and authenticated deliveries never share one. */
export type WebhookRateKind = "ingress" | "inbox";

const WINDOW_MS = 60_000;

/** Rows older than this are unreachable by every read: the window they count is
 *  long over. Deleted by the sweep so the table does not grow forever. */
const RETENTION_MS = 60 * 60 * 1000;

export interface WebhookRateDecision {
  allowed: boolean;
  /** Requests counted in this window, including the one just counted. */
  count: number;
  limit: number;
  windowStart: Date;
}

export function webhookRateWindowStart(now: Date = new Date()): Date {
  return new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
}

/**
 * Count this request and answer whether it may proceed. The window start is part
 * of the primary key, so one upsert is the entire fixed-window algorithm: a new
 * minute inserts a fresh row instead of needing a reset, and concurrent requests
 * serialize on the row rather than on a read-then-write.
 *
 * Deliberately counts the refused requests too. A sender that keeps hammering a
 * limited endpoint stays limited for the rest of the window.
 *
 * The `kind` splits the budget: "ingress" is charged before authentication to
 * bound CPU from an unauthenticated flood, "inbox" only after a valid signature
 * so junk can never starve the real sender. Both are keyed on the same window,
 * so a new minute inserts fresh rows for each kind.
 *
 * Call this only once the endpoint id has resolved to a live row: the counter
 * has a foreign key to webhook_trigger_endpoints, so an unknown id raises 23503
 * instead of limiting anything. A flood against unknown or revoked endpoint ids
 * belongs in recordWebhookRejection, which is keyless exactly for that case.
 */
export async function checkAndIncrementWebhookRate(
  db: Db,
  endpointId: string,
  kind: WebhookRateKind,
  limitPerMinute: number,
  now: Date = new Date(),
): Promise<WebhookRateDecision> {
  const windowStart = webhookRateWindowStart(now);
  const rows = await db
    .insert(webhookTriggerRateLimits)
    .values({ endpointId, windowStart, kind, count: 1 })
    .onConflictDoUpdate({
      target: [
        webhookTriggerRateLimits.endpointId,
        webhookTriggerRateLimits.windowStart,
        webhookTriggerRateLimits.kind,
      ],
      set: { count: sql`${webhookTriggerRateLimits.count} + 1` },
    })
    .returning({ count: webhookTriggerRateLimits.count });
  const count = rows[0]?.count ?? 1;
  return { allowed: count <= limitPerMinute, count, limit: limitPerMinute, windowStart };
}

/** Housekeeping for windows nothing can read again. */
export async function sweepWebhookRateLimits(
  db: Db,
  now: Date = new Date(),
): Promise<void> {
  await db
    .delete(webhookTriggerRateLimits)
    .where(
      lt(webhookTriggerRateLimits.windowStart, new Date(now.getTime() - RETENTION_MS)),
    );
}
