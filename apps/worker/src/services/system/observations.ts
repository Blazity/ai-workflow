import { createHash } from "node:crypto";
import {
  getConnectedLatestSystemHealthObservations,
  recordConnectedSystemHealthObservation,
  sweepConnectedSystemHealthObservations,
  type SystemHealthObservation,
  type SystemHealthObservationOutcome,
} from "../../db/repositories/system-health.js";
import { deploymentPublicBaseUrl } from "../../infra/public-base-url.js";
import { WEBHOOK_DELIVERY_CHECK_ID } from "./collect.js";

export type { SystemHealthObservation, SystemHealthObservationOutcome };

/**
 * A one-way scope for evidence this deployment records, from the value that
 * tells it apart from another deployment writing to the same database: its
 * public address (see `webhookDeliveryScope`).
 */
export function systemHealthObservationScope(identity: string | undefined): string {
  if (!identity) return "deployment:unconfigured";
  return `deployment:${createHash("sha256").update(identity).digest("hex")}`;
}

/**
 * Webhook deliveries as THIS deployment saw them: every integration's, and
 * core's own Resend webhook's.
 *
 * The routes write them and the health page reads them, both through the pair
 * below, so the two cannot disagree about which deployment's record
 * they mean. The scope is the deployment's public address, hashed: demo shares
 * production's database, and a delivery demo accepted must not paint
 * production's webhook Live. Core never reads an integration's signing secret
 * to tell the two apart, which is what the scope used to be derived from.
 */
function webhookDeliveryScope(): string {
  return systemHealthObservationScope(deploymentPublicBaseUrl());
}

export function recordWebhookDelivery(
  input: {
    integrationId: string;
    outcome: SystemHealthObservationOutcome;
    reason: string;
  },
  now: Date = new Date(),
): Promise<void> {
  return recordConnectedSystemHealthObservation(
    { ...input, checkId: WEBHOOK_DELIVERY_CHECK_ID, scope: webhookDeliveryScope() },
    now,
  );
}

export function latestWebhookDeliveries(integrationId: string): Promise<SystemHealthObservation[]> {
  return getConnectedLatestSystemHealthObservations(
    integrationId,
    WEBHOOK_DELIVERY_CHECK_ID,
    webhookDeliveryScope(),
  );
}

export function sweepSystemHealthObservations(
  now: Date = new Date(),
): Promise<void> {
  return sweepConnectedSystemHealthObservations(now);
}
