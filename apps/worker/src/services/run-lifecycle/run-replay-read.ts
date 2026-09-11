/**
 * The recorded replay of one run, as the dashboard reads it.
 *
 * The observation store already refuses what an organization may not see and
 * says so with a status code; this binds the connection and re-declares that
 * refusal as part of this cluster's interface, so the route maps it to HTTP
 * without reaching past the service tier for the class it matches on.
 */
import type {
  WorkflowReplayAttemptDetail,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import { getDb } from "../../db/client.js";
import {
  RunObservationStoreError,
  getRunReplay,
  getRunReplayAttempt,
} from "../../db/repositories/runs/run-observability.js";

/**
 * The store's own refusal, re-declared here so the transport can map it to its
 * status code without importing past the service tier.
 */
export { RunObservationStoreError };

/** One page of a run's replay. */
export function readRunReplay(options: {
  organizationId: string;
  runId: string;
  limit: number;
  cursor?: string;
}): Promise<WorkflowRunReplayResponse> {
  const { organizationId, runId, limit, cursor } = options;
  return getRunReplay({
    db: getDb(),
    organizationId,
    runId,
    limit,
    ...(cursor ? { cursor } : {}),
  });
}

/** One attempt of a run's replay, or null when that pair names nothing. */
export function readRunReplayAttempt(options: {
  organizationId: string;
  runId: string;
  attemptId: number;
}): Promise<WorkflowReplayAttemptDetail | null> {
  return getRunReplayAttempt({ db: getDb(), ...options });
}
