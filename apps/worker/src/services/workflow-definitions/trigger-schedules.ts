/**
 * The schedule behind one trigger node, as the editor manages it.
 *
 * A schedule row is minted when a definition deploys, so everything here has to
 * cope with a node that is authored but has no row yet, and reading is allowed
 * to heal that. Pausing and resuming are compare-and-report rather than
 * fire-and-forget: the store writes, then the row is read back, because the
 * instant that matters is the database's and an already paused schedule keeps
 * its first one.
 */
import type { ScheduleEvaluationState } from "@shared/contracts";
import {
  type OccurrenceRow,
} from "../schedule-trigger/index.js";
import {
  getConnectedScheduleById,
  listConnectedOccurrencesForSchedule,
  listConnectedSchedulesForDefinition,
  mintConnectedSchedulesForLiveHead,
  pauseConnectedSchedule,
  resumeConnectedSchedule,
  type MintableScheduleNode,
  type ScheduleRow,
} from "../../schedule-trigger/schedule-store.js";
import { runnableDefinitionOf } from "../../db/repositories/definitions.js";
import {
  getConnectedWorkflowDefinition,
} from "../../db/repositories/definitions/connected.js";
import { readConnectedDeployedWorkflowDefinitionVersion } from "../../engine/stored-definition-reads.js";

export type { OccurrenceRow, ScheduleRow };

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

export interface ScheduleConfig {
  row: ScheduleRow | null;
  occurrences: OccurrenceRow[];
}

/** The target's schedule row, or null when the node has never been deployed
 *  (schedules are minted on deploy, or by this cluster's own heal). */
export function findTriggerScheduleRow(
  target: ScheduleTarget,
): Promise<ScheduleRow | null> {
  return findScheduleRow(target);
}

/**
 * Everything the editor shows for one schedule trigger node.
 *
 * Reading also heals, exactly like the webhook endpoint's config route: a
 * schedule row is minted when the definition deploys (syncSchedulesForLiveHead in
 * services/workflow-definitions/policy-operations.ts), so healing here covers the definition that was
 * deployed before this trigger existed and the deploy whose best-effort sync did
 * not land. The heal is a write, so the caller says whether this request is
 * allowed to make it: a plain member's read must not.
 */
export async function readTriggerScheduleConfig(
  target: ScheduleTarget,
  options: { mayHeal: boolean },
): Promise<ScheduleConfig> {
  let row = await findScheduleRow(target);
  if (!row && options.mayHeal) {
    row = await healMissingSchedule(target);
  }
  if (!row) return { row: null, occurrences: [] };

  return {
    row,
    occurrences: await listConnectedOccurrencesForSchedule(row.id, OCCURRENCE_HISTORY_LIMIT),
  };
}

/** Nothing to pause or resume: the node has no schedule row at all. */
export type TriggerScheduleMutation =
  | { found: false }
  | { found: true; row: ScheduleRow };

/**
 * Stop evaluating this schedule, keeping its history and its authored fields.
 * The row is read back so the caller reports the pause instant the database
 * recorded, which for an already paused schedule is the first one.
 */
export async function pauseTriggerSchedule(
  target: ScheduleTarget,
): Promise<TriggerScheduleMutation> {
  const row = await findScheduleRow(target);
  if (!row) return { found: false };

  await pauseConnectedSchedule(row.id);
  const paused = await findScheduleRow(target);
  return paused ? { found: true, row: paused } : { found: false };
}

/** Resume a paused schedule, then read back what the write actually did. */
export async function resumeTriggerSchedule(
  target: ScheduleTarget,
): Promise<TriggerScheduleMutation> {
  const row = await findScheduleRow(target);
  if (!row) return { found: false };

  await resumeConnectedSchedule(row.id);
  const resumed = await findScheduleRow(target);
  return resumed ? { found: true, row: resumed } : { found: false };
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

async function findScheduleRow(target: ScheduleTarget): Promise<ScheduleRow | null> {
  const rows = await listConnectedSchedulesForDefinition(target.definitionId);
  return rows.find((row) => row.nodeId === target.nodeId) ?? null;
}

/**
 * The target's node in the definition's live deployed head. Null unless the
 * definition is enabled, not archived, has a deployed head, and that head
 * declares this schedule node: mirrors the webhook endpoint's own check
 * exactly, including why each of the four conditions matters. Only the node is
 * returned: its only caller mints from it and has no use for the version.
 */
async function findDeployedScheduleNode(
  target: ScheduleTarget,
): Promise<MintableScheduleNode | null> {
  const definition = await getConnectedWorkflowDefinition(target.definitionId);
  if (!definition || !definition.enabled || definition.archivedAt) return null;
  const head = await readConnectedDeployedWorkflowDefinitionVersion(target.definitionId);
  const graph = runnableDefinitionOf(head);
  if (!graph) return null;
  const node = graph.nodes.find(
    (n) => n.id === target.nodeId && n.type === "trigger_schedule",
  );
  if (!node) return null;
  return { id: node.id, type: "trigger_schedule", configuration: node.configuration ?? {} };
}

async function healMissingSchedule(target: ScheduleTarget): Promise<ScheduleRow | null> {
  const node = await findDeployedScheduleNode(target);
  if (!node) return null;

  const [minted] = await mintConnectedSchedulesForLiveHead({
    definitionId: target.definitionId,
    nodes: [node],
  });
  if (!minted) return null;
  return getConnectedScheduleById(minted.scheduleId);
}
