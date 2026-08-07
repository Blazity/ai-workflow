import { randomBytes } from "node:crypto";
import type { WorkflowBlockType } from "@shared/contracts";
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { scheduleOccurrences, workflowSchedules } from "../db/schema.js";

/**
 * Schedule rows for trigger_schedule nodes: minting, re-sync on deploy, pause,
 * resume, revocation, and the two watermark writes a cron evaluator performs.
 *
 * The split this module exists to enforce is authored state vs row-owned state.
 * A deploy re-syncs the four authored columns (cron, timezone, overlap policy,
 * catch-up grace) because those live in the graph and the graph is the source of
 * truth for them.
 *
 * Two row-owned columns behave differently from each other on a deploy, and the
 * asymmetry is the point:
 *   - paused_at is STICKY. It records a human intention, so a customer who pauses
 *     a schedule and then redeploys the workflow must still have it paused.
 *   - revoked_at is CLEARED by a re-sync. It records only the structural fact
 *     that the node was absent from the deployed head, and a deploy carrying the
 *     node has answered that question. Copying the webhook rule here (where a
 *     revocation is a security act about a leaked secret and may never revive by
 *     itself) would wedge a schedule forever: pause it, remove the node, restore
 *     the node under the same id, and no deploy could lift the revocation, with
 *     no unrevoke endpoint to escape through.
 *
 * The evaluation watermark is the newest occurrence instant the evaluator has
 * accounted for, fired or not. Every path that moves it is spelled out below,
 * because a watermark that drifts backwards replays occurrences already decided,
 * and one that jumps forwards silently swallows occurrences that were due.
 */

export type ScheduleOverlapPolicy = "skip" | "queue" | "allow";

const OVERLAP_POLICIES: readonly string[] = ["skip", "queue", "allow"];

/** The defaults the v2 trigger_schedule config declares. Repeated here so a node
 *  whose configuration predates a field (or omits it entirely) still mints a row
 *  the check constraints accept, instead of failing a deploy. */
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_OVERLAP_POLICY: ScheduleOverlapPolicy = "skip";
const DEFAULT_CATCH_UP_GRACE_MINUTES = 60;

export type ScheduleRow = typeof workflowSchedules.$inferSelect;

/** The node fields minting reads. Structural on purpose: a caller can pass a
 *  stored graph's nodes without narrowing v1 from v2, since a schedule trigger
 *  only exists in a v2 graph and a v1 node simply never matches the type. */
export interface MintableScheduleNode {
  id: string;
  type: WorkflowBlockType;
  configuration?: Record<string, unknown>;
}

/** The four columns a deploy owns. Everything else on the row survives it. */
export interface AuthoredSchedule {
  cron: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  catchUpGraceMinutes: number;
}

export interface MintedSchedule {
  scheduleId: string;
  nodeId: string;
  /** True when this call created the row. */
  minted: boolean;
}

/** Opaque id on its own prefix, so a schedule id and a webhook endpoint id can
 *  never be mistaken for one another in a log line, a URL or a query. Unlike an
 *  endpoint id it is not published anywhere, but it is still random rather than
 *  derived, so nothing downstream can infer a definition id from it. */
export function generateScheduleId(): string {
  return `sch_${randomBytes(12).toString("hex")}`;
}

/**
 * Give every trigger_schedule node in a definition's live head a schedule row.
 * Idempotent: a node that already has a row keeps its id, its pause and both of
 * its cursors, so re-deploying re-syncs the authored schedule without restarting
 * anything. A revocation is lifted, because the node being here is what revoking
 * was waiting to hear.
 */
export async function mintSchedulesForLiveHead(
  db: Db,
  input: { definitionId: number; nodes: readonly MintableScheduleNode[] },
  now: Date = new Date(),
): Promise<MintedSchedule[]> {
  const results: MintedSchedule[] = [];
  for (const node of input.nodes) {
    if (node.type !== "trigger_schedule") continue;
    results.push(
      await resyncSchedule(
        db,
        {
          definitionId: input.definitionId,
          nodeId: node.id,
          authored: authoredFrom(node),
        },
        now,
      ),
    );
  }
  return results;
}

/**
 * Upsert one node's schedule row on (definition_id, node_id).
 *
 * The conflict target is the pair, so re-deploying the same graph updates rather
 * than duplicating. The update set names the four authored columns plus the
 * revocation lift, and nothing else: that is what keeps paused_at, the evaluation
 * watermark, last_evaluated_at and the last-started pair alive across a deploy.
 *
 * revoked_at is set to null here, and only here. Seeing this node in the deployed
 * head is the deploy answering the exact question a revocation recorded, so the
 * revocation has served its purpose. The pause is untouched: a redeployed
 * schedule that was paused comes back paused, not running.
 *
 * A brand-new row is minted with the watermark at now. Not null, and not the
 * epoch: a null or ancient watermark would make the schedule's first evaluation
 * treat every occurrence since that instant as missed, and a workflow whose runs
 * open pull requests would answer a first deploy with a flood of them.
 */
export async function resyncSchedule(
  db: Db,
  input: { definitionId: number; nodeId: string; authored: AuthoredSchedule },
  now: Date = new Date(),
): Promise<MintedSchedule> {
  const candidateId = generateScheduleId();
  const rows = await db
    .insert(workflowSchedules)
    .values({
      id: candidateId,
      definitionId: input.definitionId,
      nodeId: input.nodeId,
      cron: input.authored.cron,
      timezone: input.authored.timezone,
      overlapPolicy: input.authored.overlapPolicy,
      catchUpGraceMinutes: input.authored.catchUpGraceMinutes,
      evaluationWatermarkAt: now,
    })
    .onConflictDoUpdate({
      target: [workflowSchedules.definitionId, workflowSchedules.nodeId],
      set: {
        cron: input.authored.cron,
        timezone: input.authored.timezone,
        overlapPolicy: input.authored.overlapPolicy,
        catchUpGraceMinutes: input.authored.catchUpGraceMinutes,
        revokedAt: null,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("workflow schedule row disappeared after upsert");
  // The candidate id is random, so seeing it back means this call inserted.
  return { scheduleId: row.id, nodeId: row.nodeId, minted: row.id === candidateId };
}

export async function getScheduleById(
  db: Db,
  scheduleId: string,
): Promise<ScheduleRow | null> {
  const rows = await db
    .select()
    .from(workflowSchedules)
    .where(eq(workflowSchedules.id, scheduleId))
    .limit(1);
  return rows[0] ?? null;
}

/** Every schedule row a definition owns, revoked ones included. The caller that
 *  needs this is the deploy path: a node that vanished from the head graph is
 *  exactly a row here with no matching node, and revoking it is the only way it
 *  ever stops being evaluated. */
export async function listSchedulesForDefinition(
  db: Db,
  definitionId: number,
): Promise<ScheduleRow[]> {
  return await db
    .select()
    .from(workflowSchedules)
    .where(eq(workflowSchedules.definitionId, definitionId))
    .orderBy(asc(workflowSchedules.nodeId));
}

/**
 * Pause a schedule AND cancel the occurrence it currently has waiting, in one
 * statement.
 *
 * Pause is the stop button, not a "stop after this one". An occurrence that was
 * already admitted but has not started yet is exactly what a customer is pressing
 * pause to prevent, so leaving it pending (for the drain to start moments later,
 * on a paused schedule) would break the promise of the most basic control in the
 * feature. It is settled as 'cancelled' rather than deleted, so the ledger still
 * shows that an occurrence was due and why it never ran.
 *
 * The pause instant is first-write-wins, but the cancellation is unconditional:
 * pausing an already-paused schedule still clears anything found waiting, which
 * makes the call idempotent in the direction that matters.
 */
export async function pauseSchedule(
  db: Db,
  scheduleId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.execute(sql`
    WITH paused AS (
      UPDATE ${workflowSchedules}
      SET paused_at = ${now},
          updated_at = now()
      WHERE ${workflowSchedules.id} = ${scheduleId}
        AND ${workflowSchedules.pausedAt} IS NULL
      RETURNING ${workflowSchedules.id}
    )
    UPDATE ${scheduleOccurrences} occ
    SET outcome = 'cancelled',
        pending = false,
        skip_reason = coalesce(occ.skip_reason, 'schedule_paused'),
        updated_at = now()
    WHERE occ.schedule_id = ${scheduleId}
      AND occ.pending = true
  `);
}

/**
 * Resume a paused schedule, parking the watermark one grace window behind now.
 *
 * Not at now, and not where the pause left it. Both extremes are wrong: leaving
 * it where the pause left it presents the evaluator with the whole paused
 * interval and stampedes a backlog of expensive agent runs, while moving it to
 * now discards an occurrence that is only minutes late even though the schedule's
 * own catch-up grace says an occurrence that late is still worth running.
 *
 * So a resume behaves exactly like a scheduler outage of the same length: what
 * fits inside the grace window is caught up, everything older is forgotten. The
 * window is read from the row's own catch_up_grace_minutes inside the statement,
 * so it is always the schedule's configured tolerance and never a stale copy.
 *
 * Guarded on the row still being paused: a resume of a live schedule would
 * otherwise move its watermark and silently swallow occurrences that were due.
 */
export async function resumeSchedule(
  db: Db,
  scheduleId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(workflowSchedules)
    .set({
      pausedAt: null,
      evaluationWatermarkAt: sql`${now}::timestamptz - (${workflowSchedules.catchUpGraceMinutes} * interval '1 minute')`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(workflowSchedules.id, scheduleId), isNotNull(workflowSchedules.pausedAt)),
    );
}

/** Stop evaluating a schedule whose node is gone from the deployed head, or whose
 *  definition was disabled or archived. Keeps the first revocation instant.
 *  NOT terminal, unlike a webhook endpoint revocation: a later deploy that carries
 *  the node again clears it (see resyncSchedule), which is why no unrevoke entry
 *  point exists or is needed. */
export async function revokeSchedule(
  db: Db,
  scheduleId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(workflowSchedules)
    .set({ revokedAt: now, updatedAt: sql`now()` })
    .where(
      and(eq(workflowSchedules.id, scheduleId), isNull(workflowSchedules.revokedAt)),
    );
}

/**
 * Move the watermark forward to an occurrence instant that has been evaluated.
 *
 * Monotonic by construction: the guard refuses an instant at or behind the
 * stored watermark, so a duplicated or out-of-order tick cannot rewind it and
 * re-fire occurrences that were already decided. Returns whether it moved, which
 * is also the caller's answer to "did another worker get here first".
 */
export async function advanceWatermark(
  db: Db,
  scheduleId: string,
  occurrenceAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(workflowSchedules)
    .set({ evaluationWatermarkAt: occurrenceAt, updatedAt: sql`now()` })
    .where(
      and(
        eq(workflowSchedules.id, scheduleId),
        lt(workflowSchedules.evaluationWatermarkAt, occurrenceAt),
      ),
    )
    .returning({ id: workflowSchedules.id });
  return rows.length === 1;
}

/**
 * Record that an evaluation pass looked at this schedule, whether or not
 * anything was due. This is the only column that separates "the scheduler is not
 * running in this environment" from "nothing was due yet": the watermark alone
 * cannot tell them apart, because both leave it unmoved.
 */
export async function recordEvaluationPass(
  db: Db,
  scheduleId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(workflowSchedules)
    .set({ lastEvaluatedAt: now, updatedAt: sql`now()` })
    .where(eq(workflowSchedules.id, scheduleId));
}

/**
 * Schedules a cron tick should evaluate: neither paused nor revoked, least
 * recently evaluated first, never-evaluated ones ahead of everything.
 *
 * The limit is load-bearing, not decoration. The caller is a cron tick with a
 * hard wall-clock budget, and evaluating a schedule can dispatch a run, so an
 * unbounded pass would time out mid-flight and leave a partially evaluated
 * batch. Bounded and ordered by last_evaluated_at instead: the tail of a large
 * batch is served by the next pass, and because the order is oldest-first no
 * schedule can be starved by a busier one.
 */
export async function listEvaluableSchedules(
  db: Db,
  limit: number,
): Promise<ScheduleRow[]> {
  return await db
    .select()
    .from(workflowSchedules)
    .where(
      and(isNull(workflowSchedules.pausedAt), isNull(workflowSchedules.revokedAt)),
    )
    // NULLS FIRST is explicit because Postgres puts them last on ASC, which
    // would park a freshly minted schedule behind every evaluated one.
    .orderBy(sql`${workflowSchedules.lastEvaluatedAt} asc nulls first`)
    .limit(limit);
}

/** Read the four authored fields off a node, falling back to the config
 *  defaults. Values are not validated here: the deployment gate refuses an
 *  incomplete schedule, and the check constraints refuse an impossible one. */
function authoredFrom(node: MintableScheduleNode): AuthoredSchedule {
  const config = node.configuration ?? {};
  const cron = config.cron;
  const timezone = config.timezone;
  const overlapPolicy = config.overlapPolicy;
  const catchUpGraceMinutes = config.catchUpGraceMinutes;
  return {
    cron: typeof cron === "string" ? cron : "",
    timezone: typeof timezone === "string" && timezone !== "" ? timezone : DEFAULT_TIMEZONE,
    overlapPolicy:
      typeof overlapPolicy === "string" && OVERLAP_POLICIES.includes(overlapPolicy)
        ? (overlapPolicy as ScheduleOverlapPolicy)
        : DEFAULT_OVERLAP_POLICY,
    catchUpGraceMinutes:
      typeof catchUpGraceMinutes === "number" &&
      Number.isInteger(catchUpGraceMinutes) &&
      catchUpGraceMinutes > 0
        ? catchUpGraceMinutes
        : DEFAULT_CATCH_UP_GRACE_MINUTES,
  };
}
