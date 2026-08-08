import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { e2eEnv } from "../env.js";

/**
 * Direct DB access for e2e seeding/cleanup, same convention as
 * e2e/helpers/registry.ts: must point at the SAME Neon branch as the
 * deployment under test (vercel env pull for the matching environment).
 */
const sql = neon(e2eEnv.DATABASE_URL);

/**
 * The graph seeded here is the committed snapshot from
 * apps/worker/src/workflow-definition/scenarios/snapshots/schedule-open-pr-v1.json,
 * read as-is, never authored inline in this file. That snapshot is parsed
 * through the live workflowDefinitionSchema and the deployment validator on
 * every run of the scenario suite (loadSnapshotGraph in
 * workflow-definition/scenarios/harness.ts:309-347, exercised by
 * schedule-open-pr.scenario.test.ts), a test that runs on every commit. If
 * the graph ever stops being a valid, deployable v2 definition, that failure
 * shows up there, loudly, on its own PR, rather than silently corrupting a
 * fixture only this e2e test reads. Do not edit the graph here: edit the
 * snapshot file and let the scenario suite re-prove it.
 *
 * This helper does NOT call the dashboard-authenticated deploy path
 * (workflow-definition/store.ts's deployWorkflowDefinition). That module
 * transitively imports the worker's own env.ts, which throws at import time
 * unless a full server environment is present (BETTER_AUTH_SECRET, a
 * configured VCS provider, etc.), none of which e2e has or should fabricate.
 * So the three rows below are written directly, mirroring what a deploy
 * would leave behind, using the same raw-SQL convention registry.ts already
 * uses against this same database. Consequence: this test does NOT exercise
 * deploy's own schedule-minting path (store.ts's syncSchedulesForLiveHead),
 * which today has only unit coverage. That gap is accepted deliberately and
 * closed elsewhere: the production verification step deploys this workflow
 * for real (Vercel only runs cron on production), which is where deploy
 * actually minting a workflow_schedules row gets proven end-to-end.
 */
const SNAPSHOT_PATH = new URL(
  "../../src/workflow-definition/scenarios/snapshots/schedule-open-pr-v1.json",
  import.meta.url,
);

interface ScheduleTriggerConfiguration {
  cron: string;
  timezone: string;
  overlapPolicy: string;
}

function readSnapshotDefinition(): {
  definition: unknown;
  nodeId: string;
  trigger: ScheduleTriggerConfiguration;
} {
  const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as {
    nodes: Array<{
      id: string;
      type: string;
      configuration: Record<string, unknown>;
    }>;
  };
  const triggerNode = raw.nodes.find((node) => node.type === "trigger_schedule");
  if (!triggerNode) {
    throw new Error(
      `Snapshot ${SNAPSHOT_PATH} has no trigger_schedule node; the e2e fixture and the scenario it mirrors have drifted apart.`,
    );
  }
  return {
    definition: raw,
    nodeId: triggerNode.id,
    trigger: {
      cron: String(triggerNode.configuration.cron),
      timezone: String(triggerNode.configuration.timezone),
      overlapPolicy: String(triggerNode.configuration.overlapPolicy),
    },
  };
}

export interface SeededSchedule {
  definitionId: number;
  scheduleId: string;
  subjectKey: string;
}

/**
 * Seeds a "deployed" definition (workflow_definitions + its version 1,
 * deployed_version pointed at it) carrying the committed schedule-open-pr
 * snapshot, plus a workflow_schedules row for its trigger_schedule node with
 * an evaluation watermark set just past one cron period, so exactly one
 * occurrence is due immediately.
 *
 * The catch-up grace here (12 hours) is deliberately far more generous than
 * the 15 minutes authored in the snapshot's own trigger_schedule
 * configuration: it is a fixture dial for this test's own robustness against
 * CI scheduling delay, not a fact about the deployed graph, and the
 * tolerance window's own behavior has unit coverage against an injected
 * `now` (schedule-trigger/occurrence.test.ts). Widening it here only makes a
 * due occurrence more certainly "due" and never "stale"; it does not touch
 * the boundary those unit tests already own.
 */
export async function seedDueScheduleDefinition(): Promise<SeededSchedule> {
  const { definition, nodeId, trigger } = readSnapshotDefinition();
  const suffix = randomBytes(4).toString("hex");
  const name = `[E2E] AIW-223 schedule dispatch ${suffix}`;
  const actorId = "e2e";
  const actorLabel = "E2E schedule trigger test";

  const definitionRows = await sql`
    INSERT INTO workflow_definitions (name, enabled, trigger_types, created_by_id, created_by_label)
    VALUES (${name}, true, ARRAY['trigger_schedule'], ${actorId}, ${actorLabel})
    RETURNING id
  `;
  const definitionId = definitionRows[0]?.id as number | undefined;
  if (definitionId === undefined) {
    throw new Error("Failed to insert workflow_definitions row for e2e fixture");
  }

  // From here on, a thrown error must remove the definition row already
  // inserted above, the same defensive shape store.ts's own
  // createWorkflowDefinition uses when its seed version fails to insert: an
  // orphaned definition row (no version, deployed_version null) is harmless
  // to the app but is still litter on a Neon branch shared with every other
  // e2e test, and this function is the only place that knows it exists.
  try {
    const scheduleId = `sch_e2e_${randomBytes(8).toString("hex")}`;
    await sql`
      INSERT INTO workflow_definition_versions
        (definition_id, version, definition, created_by_id, created_by_label)
      VALUES (${definitionId}, 1, ${JSON.stringify(definition)}::jsonb, ${actorId}, ${actorLabel})
    `;

    await sql`
      UPDATE workflow_definitions SET deployed_version = 1 WHERE id = ${definitionId}
    `;

    await sql`
      INSERT INTO workflow_schedules
        (id, definition_id, node_id, cron, timezone, overlap_policy, catch_up_grace_minutes, evaluation_watermark_at)
      VALUES (
        ${scheduleId},
        ${definitionId},
        ${nodeId},
        ${trigger.cron},
        ${trigger.timezone},
        ${trigger.overlapPolicy},
        720,
        now() - interval '35 minutes'
      )
    `;

    return {
      definitionId,
      scheduleId,
      subjectKey: `schedule:${scheduleId}`,
    };
  } catch (error) {
    await cleanupSeededSchedule({ definitionId }).catch(() => {});
    throw error;
  }
}

export interface ScheduleOccurrenceRow {
  occurrenceAt: string;
  outcome: string | null;
  pending: boolean;
  runId: string | null;
}

/** Every occurrence row settled or pending for this schedule, oldest first. */
export async function listScheduleOccurrences(
  scheduleId: string,
): Promise<ScheduleOccurrenceRow[]> {
  const rows = await sql`
    SELECT occurrence_at, outcome, pending, run_id
    FROM schedule_occurrences
    WHERE schedule_id = ${scheduleId}
    ORDER BY occurrence_at ASC
  `;
  return rows.map((row) => ({
    occurrenceAt: row.occurrence_at as string,
    outcome: (row.outcome as string | null) ?? null,
    pending: row.pending as boolean,
    runId: (row.run_id as string | null) ?? null,
  }));
}

/** The active_runs registry row for a subject, the same table
 * e2e/helpers/registry.ts reads for ticket-keyed subjects; a schedule run has
 * no ticket, so this reads by subject_key instead. */
export async function getActiveRunBySubject(
  subjectKey: string,
): Promise<{ runId: string | null } | null> {
  const rows = await sql`
    SELECT run_id FROM active_runs WHERE subject_key = ${subjectKey}
  `;
  const row = rows[0];
  return row ? { runId: (row.run_id as string | null) ?? null } : null;
}

/**
 * Cleanup in reverse foreign-key order:
 *   1. workflow_definitions.deployed_version is nulled first, because it is
 *      itself a foreign key into workflow_definition_versions and would
 *      otherwise block deleting the version row.
 *   2. the version row is deleted.
 *   3. the definition row is deleted, which cascades onto workflow_schedules
 *      and, from there, onto schedule_occurrences (both declared
 *      ON DELETE CASCADE in db/schema.ts).
 * The active_runs row is unrelated by foreign key (registry table, keyed by
 * subject_key) and is deleted separately.
 *
 * Called from `afterAll`, including after a failed assertion, since this
 * suite runs against a Neon branch shared with every other e2e test.
 */
export async function cleanupSeededSchedule(
  seeded: Partial<SeededSchedule>,
): Promise<void> {
  if (seeded.subjectKey) {
    await sql`DELETE FROM active_runs WHERE subject_key = ${seeded.subjectKey}`.catch(
      () => {},
    );
  }
  if (seeded.definitionId !== undefined) {
    await sql`
      UPDATE workflow_definitions SET deployed_version = NULL WHERE id = ${seeded.definitionId}
    `.catch(() => {});
    await sql`
      DELETE FROM workflow_definition_versions WHERE definition_id = ${seeded.definitionId}
    `.catch(() => {});
    await sql`
      DELETE FROM workflow_definitions WHERE id = ${seeded.definitionId}
    `.catch(() => {});
  }
}
