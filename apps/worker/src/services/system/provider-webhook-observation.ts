import { waitUntil } from "@vercel/functions";
import { logger } from "../../infra/logger.js";
import { recordWebhookDelivery, type SystemHealthObservationOutcome } from "./observations.js";

const OBSERVATION_WRITE_INTERVAL_MS = 60_000;
const lastScheduledAt = new Map<string, number>();

/**
 * Core's own Resend webhook, recorded under the same check and the same
 * deployment scope as every integration webhook (`recordWebhookDelivery`), so
 * the health page reads both one way. What it adds is sampling: its failures
 * arrive unauthenticated, so a burst of them must not become a burst of writes.
 */
export function observeProviderWebhook(
  integrationId: "email",
  outcome: SystemHealthObservationOutcome,
  reason: string,
): void {
  const key = `${integrationId}:${outcome}:${reason}`;
  const now = Date.now();
  const previous = lastScheduledAt.get(key);
  if (previous !== undefined && now - previous < OBSERVATION_WRITE_INTERVAL_MS) return;
  lastScheduledAt.set(key, now);

  let write: Promise<void>;
  try {
    write = recordWebhookDelivery({ integrationId, outcome, reason });
  } catch (error) {
    logWriteFailure(integrationId, outcome, reason, error);
    return;
  }
  write = write.catch((error) => {
    logWriteFailure(integrationId, outcome, reason, error);
  });
  waitUntil(write);
}

function logWriteFailure(
  integrationId: string,
  outcome: SystemHealthObservationOutcome,
  reason: string,
  error: unknown,
): void {
  logger.warn(
    {
      integrationId,
      outcome,
      reason,
      error: error instanceof Error ? error.message : String(error),
    },
    "system_health_observation_write_failed",
  );
}
