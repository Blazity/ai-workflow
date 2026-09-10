import type {
  ScheduleConfigResponse,
  ScheduleOccurrenceEntry,
  ScheduleOccurrenceOutcome,
  ScheduleStatus,
} from "@shared/contracts";
import { createError, defineEventHandler, getRouterParam, type H3Event } from "h3";
import {
  canDispatchWorkflowRuns,
  requireDashboardActor,
  toHttpError,
} from "../../../../../../../../services/auth/index.js";
import {
  deriveScheduleState,
  readTriggerScheduleConfig,
  SCHEDULE_STALE_EVALUATION_MS,
  type OccurrenceRow,
  type ScheduleRow,
  type ScheduleTarget,
} from "../../../../../../../../services/workflow-definitions/index.js";
import { parseDefinitionId } from "../../../../../workflow-definitions.get.js";

/**
 * Shared pieces of the four schedule-management routes (config, pause, resume,
 * preview). No separate module for these: config.get.ts plays the role
 * endpoint-route.ts plays for the webhook trigger, and pause.post.ts /
 * resume.post.ts import from here the same way manual-dispatch.post.ts imports
 * parseDefinitionId from workflow-definitions.get.js.
 */

/** Re-exported so the schedule routes and their tests keep one name for the
 *  staleness window, which is decided in the service that derives the state. */
export { SCHEDULE_STALE_EVALUATION_MS };

export function parseScheduleTarget(event: H3Event): ScheduleTarget {
  const definitionId = parseDefinitionId(event);
  const nodeId = getRouterParam(event, "nodeId")?.trim();
  if (!nodeId) {
    throw createError({ statusCode: 404, statusMessage: "Unknown trigger" });
  }
  return { definitionId, nodeId };
}

/** Reads are open to every dashboard member; pause and resume change what the
 *  scheduler does, so they share the cockpit mutation role. */
export async function requireScheduleActor(event: H3Event, mutation: boolean) {
  const actor = await requireDashboardActor(event);
  if (mutation && !canDispatchWorkflowRuns(actor.role)) {
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  }
  return actor;
}

export function serializeScheduleStatus(row: ScheduleRow, now: Date): ScheduleStatus {
  return {
    scheduleId: row.id,
    cron: row.cron,
    timezone: row.timezone,
    pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastEvaluatedAt: row.lastEvaluatedAt ? row.lastEvaluatedAt.toISOString() : null,
    lastStartedOccurrenceAt: row.lastStartedOccurrenceAt
      ? row.lastStartedOccurrenceAt.toISOString()
      : null,
    lastStartedRunId: row.lastStartedRunId,
    serverNow: now.toISOString(),
  };
}

/**
 * Everything the editor shows for one schedule trigger node.
 *
 * Reading also heals, exactly like the webhook endpoint's config.get.ts, and
 * that heal is a write: it is gated on the mutation role, so a member's GET
 * cannot write.
 */
export default defineEventHandler(
  async (event): Promise<ScheduleConfigResponse | undefined> => {
    try {
      const actor = await requireScheduleActor(event, false);
      const target = parseScheduleTarget(event);
      const now = new Date();

      const config = await readTriggerScheduleConfig(target, {
        mayHeal: canDispatchWorkflowRuns(actor.role),
      });
      if (!config.row) {
        return { state: "draft", schedule: null, occurrences: [] };
      }

      return {
        state: deriveScheduleState(config.row, now),
        schedule: serializeScheduleStatus(config.row, now),
        occurrences: config.occurrences.map(serializeOccurrenceEntry),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);

function serializeOccurrenceEntry(row: OccurrenceRow): ScheduleOccurrenceEntry {
  return {
    occurrenceAt: row.occurrenceAt.toISOString(),
    pending: row.pending,
    outcome: row.outcome as ScheduleOccurrenceOutcome | null,
    skipReason: row.skipReason,
    blockingRunId: row.blockingRunId,
    runId: row.runId,
    droppedCount: row.droppedCount,
    droppedCountCapped: row.droppedCountCapped,
    attemptCount: row.attemptCount,
  };
}
