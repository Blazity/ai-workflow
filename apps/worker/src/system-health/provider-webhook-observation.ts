import { waitUntil } from "@vercel/functions";
import { env } from "../../env.js";
import { getDb } from "../db/client.js";
import { logger } from "../lib/logger.js";
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
    write = recordSystemHealthObservation(getDb(), {
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

function providerWebhookSecret(
  integrationId: "github" | "gitlab" | "jira" | "slack" | "email",
): string | undefined {
  switch (integrationId) {
    case "github":
      return env.GITHUB_WEBHOOK_SECRET;
    case "gitlab":
      return env.GITLAB_WEBHOOK_SECRET;
    case "jira":
      return env.JIRA_WEBHOOK_SECRET;
    case "slack":
      return env.SLACK_SIGNING_SECRET;
    case "email":
      return env.RESEND_WEBHOOK_SECRET;
  }
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
