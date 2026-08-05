import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { WebhookRejectionSummaryEntry } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { webhookTriggerRejectionCounters } from "../db/schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Long enough to see a pattern ("this endpoint has been failing since the
 *  rotation"), short enough that the table stays small. */
const RETENTION_DAYS = 30;

export function webhookRejectionWindowStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Tally one request that was refused before it could become a delivery. A
 * rejection writes no webhook_trigger_deliveries row, so this counter is the
 * only trace an endpoint that refuses everything leaves behind.
 *
 * The endpoint id is recorded even when no such endpoint exists: "someone is
 * posting to a URL that was revoked" is exactly the case worth surfacing.
 */
export async function recordWebhookRejection(
  db: Db,
  endpointId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(webhookTriggerRejectionCounters)
    .values({
      endpointId,
      windowStart: webhookRejectionWindowStart(now),
      reason,
      count: 1,
    })
    .onConflictDoUpdate({
      target: [
        webhookTriggerRejectionCounters.endpointId,
        webhookTriggerRejectionCounters.windowStart,
        webhookTriggerRejectionCounters.reason,
      ],
      set: { count: sql`${webhookTriggerRejectionCounters.count} + 1` },
    });
}

/** Today's refusals grouped by reason, worst first, for the endpoint panel. */
export async function getWebhookRejectionsToday(
  db: Db,
  endpointId: string,
  now: Date = new Date(),
): Promise<WebhookRejectionSummaryEntry[]> {
  return db
    .select({
      reason: webhookTriggerRejectionCounters.reason,
      count: webhookTriggerRejectionCounters.count,
    })
    .from(webhookTriggerRejectionCounters)
    .where(
      and(
        eq(webhookTriggerRejectionCounters.endpointId, endpointId),
        eq(webhookTriggerRejectionCounters.windowStart, webhookRejectionWindowStart(now)),
      ),
    )
    .orderBy(desc(webhookTriggerRejectionCounters.count));
}

export async function sweepWebhookRejectionCounters(
  db: Db,
  now: Date = new Date(),
): Promise<void> {
  await db
    .delete(webhookTriggerRejectionCounters)
    .where(
      lt(
        webhookTriggerRejectionCounters.windowStart,
        new Date(webhookRejectionWindowStart(now).getTime() - RETENTION_DAYS * DAY_MS),
      ),
    );
}
