import { createHash } from "node:crypto";
import {
  getConnectedLatestSystemHealthObservations,
  observationWindowStart,
  recordConnectedSystemHealthObservation,
  sweepConnectedSystemHealthObservations,
  type SystemHealthObservation,
  type SystemHealthObservationOutcome,
} from "../../db/repositories/system-health.js";

export type { SystemHealthObservation, SystemHealthObservationOutcome };

export function systemHealthObservationWindowStart(now: Date = new Date()): Date {
  return observationWindowStart(now);
}

export function systemHealthObservationScope(secret: string | undefined): string {
  if (!secret) return "deployment:unconfigured";
  return `deployment:${createHash("sha256").update(secret).digest("hex")}`;
}

export function recordSystemHealthObservation(
  input: {
    integrationId: string;
    checkId: string;
    scope?: string;
    outcome: SystemHealthObservationOutcome;
    reason: string;
  },
  now: Date = new Date(),
): Promise<void> {
  return recordConnectedSystemHealthObservation(input, now);
}

export function getLatestSystemHealthObservations(
  integrationId: string,
  checkId: string,
  scope?: string,
): Promise<SystemHealthObservation[]> {
  return getConnectedLatestSystemHealthObservations(integrationId, checkId, scope);
}

export function sweepSystemHealthObservations(
  now: Date = new Date(),
): Promise<void> {
  return sweepConnectedSystemHealthObservations(now);
}
