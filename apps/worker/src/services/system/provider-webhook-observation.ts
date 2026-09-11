import { waitUntil } from "@vercel/functions";
import { logger } from "../../infra/logger.js";
import { providerWebhookSecret } from "../settings/index.js";
import {
  recordSystemHealthObservation,
  systemHealthObservationScope,
  type SystemHealthObservationOutcome,
} from "./observations.js";

const OBSERVATION_WRITE_INTERVAL_MS = 60_000;
const lastScheduledAt = new Map<string, number>();

export function observeProviderWebhook(
  integrationId: "github" | "gitlab" | "jira" | "slack" | "email",
  outcome: SystemHealthObservationOutcome,
  reason: string,
): void {
  const scope = systemHealthObservationScope(providerWebhookSecret(integrationId));
  const key = `${integrationId}:${scope}:${outcome}:${reason}`;
  const now = Date.now();
  const previous = lastScheduledAt.get(key);
  if (previous !== undefined && now - previous < OBSERVATION_WRITE_INTERVAL_MS) return;
  lastScheduledAt.set(key, now);

  let write: Promise<void>;
  try {
    write = recordSystemHealthObservation({
      integrationId,
      checkId: "webhook-delivery",
      scope,
      outcome,
      reason,
    });
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
