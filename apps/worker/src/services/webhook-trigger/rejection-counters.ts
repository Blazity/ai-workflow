import type { WebhookRejectionSummaryEntry } from "@shared/contracts";
import {
  incrementConnectedWebhookTriggerRejection,
  incrementWebhookTriggerRejection,
  listWebhookTriggerRejections,
  sweepConnectedExpiredWebhookTriggerRejections,
  sweepExpiredWebhookTriggerRejections,
} from "../../db/repositories/webhook-trigger-deliveries.js";

type WebhookRejectionDb = Parameters<typeof incrementWebhookTriggerRejection>[0];

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
  db: WebhookRejectionDb,
  endpointId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await incrementWebhookTriggerRejection(db, {
    endpointId,
    windowStart: webhookRejectionWindowStart(now),
    reason,
  });
}

export async function recordConnectedWebhookRejection(
  endpointId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await incrementConnectedWebhookTriggerRejection({
    endpointId,
    windowStart: webhookRejectionWindowStart(now),
    reason,
  });
}

/** Today's refusals grouped by reason, worst first, for the endpoint panel. */
export async function getWebhookRejectionsToday(
  db: WebhookRejectionDb,
  endpointId: string,
  now: Date = new Date(),
): Promise<WebhookRejectionSummaryEntry[]> {
  return listWebhookTriggerRejections(db, {
    endpointId,
    windowStart: webhookRejectionWindowStart(now),
  });
}

export async function sweepWebhookRejectionCounters(
  db: WebhookRejectionDb,
  now: Date = new Date(),
): Promise<void> {
  await sweepExpiredWebhookTriggerRejections(
    db,
    new Date(webhookRejectionWindowStart(now).getTime() - RETENTION_DAYS * DAY_MS),
  );
}

export function sweepConnectedWebhookRejectionCounters(
  now: Date = new Date(),
): Promise<void> {
  return sweepConnectedExpiredWebhookTriggerRejections(
    new Date(webhookRejectionWindowStart(now).getTime() - RETENTION_DAYS * DAY_MS),
  );
}
