import type {
  ScheduleConfigResponse,
  ScheduleEvaluationState,
  ScheduleOccurrenceEntry,
  ScheduleOccurrenceOutcome,
  ScheduleStatus,
} from "@shared/contracts";
import { createError, defineEventHandler, getRouterParam, type H3Event } from "h3";
import { getDb, type Db } from "../../../../../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../../../../../lib/auth/request-context.js";
import { canDispatchWorkflowRuns } from "../../../../../../../../lib/auth/roles.js";
import {
  listOccurrencesForSchedule,
  type OccurrenceRow,
} from "../../../../../../../../schedule-trigger/occurrence-store.js";
import {
  getScheduleById,
  listSchedulesForDefinition,
  mintSchedulesForLiveHead,
  type MintableScheduleNode,
  type ScheduleRow,
} from "../../../../../../../../schedule-trigger/schedule-store.js";
import {
  getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinition,
} from "../../../../../../../../workflow-definition/store.js";
import { parseDefinitionId } from "../../../../../workflow-definitions.get.js";

/**
 * Shared pieces of the four schedule-management routes (config, pause, resume,
 * preview). No separate module for these: config.get.ts plays the role
 * endpoint-route.ts plays for the webhook trigger, and pause.post.ts /
 * resume.post.ts import from here the same way manual-dispatch.post.ts imports
 * parseDefinitionId from workflow-definitions.get.js.
 */

/**
 * How stale last_evaluated_at may be before the editor stops trusting the
 * next-run preview. The platform cron ticks once a minute (see occurrence.ts's
 * own module comment), so one tick would already flag a perfectly healthy
 * schedule that is merely waiting its turn behind others in
 * listEvaluableSchedules' bounded batch. Five ticks is enough slack for that
 * without blunting the signal: a scheduler that is actually not running in this
 * environment stays stale forever, not for five minutes.
 */
export const SCHEDULE_STALE_EVALUATION_MS = 5 * 60 * 1000;

/** How much occurrence history the editor shows. Mirrors DELIVERY_LOG_LIMIT in
 *  the webhook trigger's deliveries.get.ts: enough to see a pattern, small
 *  enough to stay one query and one render. */
const OCCURRENCE_HISTORY_LIMIT = 20;

export interface ScheduleTarget {
  definitionId: number;
  nodeId: string;
}

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

/** The target's schedule row, or null when the node has never been deployed
 *  (mintSchedulesForLiveHead only runs on deploy or on this route's own heal). */
export async function findScheduleRow(
  db: Db,
  target: ScheduleTarget,
): Promise<ScheduleRow | null> {
  const rows = await listSchedulesForDefinition(db, target.definitionId);
  return rows.find((row) => row.nodeId === target.nodeId) ?? null;
}

export async function requireScheduleRow(db: Db, target: ScheduleTarget): Promise<ScheduleRow> {
  const row = await findScheduleRow(db, target);
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: "Unknown schedule" });
  }
  return row;
}

/**
 * The target's node in the definition's live deployed head. Null unless the
 * definition is enabled, not archived, has a deployed head, and that head
 * declares this schedule node: mirrors findDeployedWebhookNode in
 * webhook/endpoint-route.ts exactly, including why each of the four
 * conditions matters. Only the node is returned: its only caller mints from
 * it and has no use for the definition version.
 */
export async function findDeployedScheduleNode(
  db: Db,
  target: ScheduleTarget,
): Promise<MintableScheduleNode | null> {
  const definition = await getWorkflowDefinition(db, target.definitionId);
  if (!definition || !definition.enabled || definition.archivedAt) return null;
  const head = await getDeployedWorkflowDefinitionVersion(db, target.definitionId);
  if (!head) return null;
  const nodes = head.definition.nodes as readonly {
    id: string;
    type: string;
    configuration?: Record<string, unknown>;
  }[];
  const node = nodes.find((n) => n.id === target.nodeId && n.type === "trigger_schedule");
  if (!node) return null;
  return { id: node.id, type: "trigger_schedule", configuration: node.configuration ?? {} };
}

/**
 * Which of the five states the editor must show, in priority order.
 *
 * Revoked outranks everything: a revoked row's node is not in the deployed
 * head at all (the definition was redeployed without it, or disabled, or
 * archived), which is a structural fact about the graph, not a health
 * question about the scheduler. Showing "not evaluated" for a revoked row
 * would send an operator looking for an outage that does not exist; the fix
 * here is restoring the node and deploying, not pausing or waiting.
 *
 * Paused outranks "not evaluated": listEvaluableSchedules excludes a paused
 * schedule entirely, so last_evaluated_at freezes the moment it is paused and
 * that freeze is the intended behaviour, not a sign the scheduler stopped.
 */
export function deriveScheduleState(row: ScheduleRow, now: Date): ScheduleEvaluationState {
  if (row.revokedAt !== null) return "revoked";
  if (row.pausedAt !== null) return "paused";
  if (row.lastEvaluatedAt === null) return "not_evaluated";
  if (now.getTime() - row.lastEvaluatedAt.getTime() > SCHEDULE_STALE_EVALUATION_MS) {
    return "not_evaluated";
  }
  return "evaluating";
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

export function serializeOccurrenceEntry(row: OccurrenceRow): ScheduleOccurrenceEntry {
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

/**
 * Everything the editor shows for one schedule trigger node.
 *
 * Reading also heals, exactly like the webhook endpoint's config.get.ts: a
 * schedule row is minted when the definition deploys (syncSchedulesForLiveHead in
 * workflow-definition/store.ts), so healing here covers the definition that was
 * deployed before this trigger existed and the deploy whose best-effort sync did
 * not land. Gated on the mutation role, so a member's GET cannot write.
 */
export default defineEventHandler(
  async (event): Promise<ScheduleConfigResponse | undefined> => {
    try {
      const actor = await requireScheduleActor(event, false);
      const target = parseScheduleTarget(event);
      const db = getDb();
      const now = new Date();

      let row = await findScheduleRow(db, target);
      if (!row && canDispatchWorkflowRuns(actor.role)) {
        row = await healMissingSchedule(db, target);
      }
      if (!row) {
        return { state: "draft", schedule: null, occurrences: [] };
      }

      const occurrences = await listOccurrencesForSchedule(
        db,
        row.id,
        OCCURRENCE_HISTORY_LIMIT,
      );
      return {
        state: deriveScheduleState(row, now),
        schedule: serializeScheduleStatus(row, now),
        occurrences: occurrences.map(serializeOccurrenceEntry),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);

async function healMissingSchedule(db: Db, target: ScheduleTarget): Promise<ScheduleRow | null> {
  const node = await findDeployedScheduleNode(db, target);
  if (!node) return null;

  const [minted] = await mintSchedulesForLiveHead(db, {
    definitionId: target.definitionId,
    nodes: [node],
  });
  if (!minted) return null;
  return getScheduleById(db, minted.scheduleId);
}
