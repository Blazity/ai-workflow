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
 * apps/worker/src/workflow-graph-suites/scenarios/snapshots/schedule-open-pr-v1.json,
 * read as-is, never authored inline in this file. That snapshot is parsed
 * through the live workflowDefinitionSchema and the deployment validator on
 * every run of the scenario suite (loadSnapshotGraph in
 * workflow-graph-suites/scenarios/harness.ts:309-347, exercised by
 * schedule-open-pr.scenario.test.ts), a test that runs on every commit. If
 * the graph ever stops being a valid, deployable v2 definition, that failure
 * shows up there, loudly, on its own PR, rather than silently corrupting a
 * fixture only this e2e test reads. Do not edit the graph here: edit the
 * snapshot file and let the scenario suite re-prove it.
 *
 * This helper does NOT call the dashboard-authenticated deploy path
 * (workflow-definition/store.ts's deployWorkflowDefinition). That module
 * transitively imports the worker's own `src/infra/runtime-env.ts`, which throws at import time
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
  "../../src/workflow-graph-suites/scenarios/snapshots/schedule-open-pr-v1.json",
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
/** Every fixture this helper seeds is named with this prefix, which is how the
 *  sweep below finds the ones an earlier run could not tear down. */
const FIXTURE_NAME_PREFIX = "[E2E] AIW-223 schedule dispatch ";

export async function seedDueScheduleDefinition(): Promise<SeededSchedule> {
  const { definition, nodeId, trigger } = readSnapshotDefinition();
  const suffix = randomBytes(4).toString("hex");
  const name = `${FIXTURE_NAME_PREFIX}${suffix}`;
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

  // From here on, a thrown error must retire the definition row already
  // inserted above: it was inserted enabled, and this function is the only
  // place that knows it exists.
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
 * Teardown: disable, archive and revoke the fixture, in one statement, and fail
 * loudly when that does not happen.
 *
 * The rows are NOT deleted. Once the first poll starts a run, that run's replay
 * observation and its occurrence reference the definition version through
 * foreign keys (workflow_run_observations restricts the delete outright), so the
 * version cannot go, and neither can the definition that owns it. The previous
 * teardown nulled deployed_version first and then swallowed every failed delete,
 * which left the definition ENABLED with nothing deployed behind it: eleven of
 * those sat on production by 2026-09-25 (definitions 39 to 58), and disabling
 * them answered as if a schedule had been live. Archived and disabled is the
 * state a person retiring a workflow leaves behind, it keeps the run this suite
 * started readable in the run history, and it takes the fixture off every list.
 *
 * One statement because production runs on neon-http, which cannot open a
 * transaction: the three writes either all land or none does.
 *
 * Called from `afterAll`, including after a failed assertion, and from the
 * seeding function when it fails halfway.
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
    await retireFixtureDefinitions(sql`id = ${seeded.definitionId}`);
  }
}

/**
 * Retires fixtures an earlier run left behind: a runner killed mid-suite never
 * reaches `afterAll`. Only fixtures older than an hour, so a suite started by
 * hand beside the scheduled one is never pulled out from under itself.
 */
export async function sweepStaleScheduleFixtures(): Promise<void> {
  await retireFixtureDefinitions(
    sql`name LIKE ${`${FIXTURE_NAME_PREFIX}%`} AND created_at < now() - interval '1 hour'`,
  );
}

async function retireFixtureDefinitions(
  where: ReturnType<typeof sql>,
): Promise<void> {
  await sql`
    WITH retired AS (
      UPDATE workflow_definitions
      SET enabled = false,
          archived_at = coalesce(archived_at, now()),
          updated_at = now()
      WHERE archived_at IS NULL AND ${where}
      RETURNING id
    ), revoked AS (
      UPDATE workflow_schedules
      SET revoked_at = coalesce(revoked_at, now()), updated_at = now()
      WHERE definition_id IN (SELECT id FROM retired)
      RETURNING id
    )
    UPDATE schedule_occurrences
    SET outcome = 'cancelled',
        pending = false,
        skip_reason = coalesce(skip_reason, 'schedule_revoked'),
        updated_at = now()
    WHERE pending = true AND schedule_id IN (SELECT id FROM revoked)
  `;
}
