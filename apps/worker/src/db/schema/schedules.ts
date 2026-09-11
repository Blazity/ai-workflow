import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workflowDefinitionVersions, workflowDefinitions } from "./definitions.js";

export const workflowSchedules = pgTable(
  "workflow_schedules",
  {
    id: text("id").primaryKey(),
    definitionId: integer("definition_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    overlapPolicy: text("overlap_policy").notNull().default("skip"),
    catchUpGraceMinutes: integer("catch_up_grace_minutes").notNull().default(60),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    /**
     * Bookkeeping cursor, NOT a display value: the newest occurrence instant the
     * evaluator has accounted for, whether it fired, was skipped as stale, or was
     * never worth firing. Minting and resuming also park it at a synthetic instant
     * that never corresponded to an occurrence at all.
     *
     * Named for what it is because it used to be called last_occurrence_at, and
     * under that name a caller reasonably rendered it as "last run": a freshly
     * minted schedule then advertised a run at its creation time and a resumed one
     * advertised a run that never happened. What a reader wants is
     * last_started_occurrence_at below.
     *
     * NOT NULL with a now() default because the default IS the invariant: a row
     * that started at null would make its first evaluation treat every occurrence
     * since the epoch as missed.
     */
    evaluationWatermarkAt: timestamp("evaluation_watermark_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** That an evaluation pass ran at all, including one that found nothing due.
     * Distinct from the watermark on purpose: only this column tells
     * "the scheduler is not running in this environment" (still null, or long
     * stale) apart from "nothing was due yet" (fresh, watermark unmoved). */
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    /** The last occurrence that actually started a run, and that run. Written only
     *  when a start is published, so this is the truthful "last run" a UI should
     *  show, and it is the only record of a successful firing that outlives the
     *  occurrence ledger's retention window. */
    lastStartedOccurrenceAt: timestamp("last_started_occurrence_at", {
      withTimezone: true,
    }),
    lastStartedRunId: text("last_started_run_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "workflow_schedules_overlap_policy_check",
      sql`${t.overlapPolicy} in ('skip', 'queue', 'allow')`,
    ),
    check(
      "workflow_schedules_catch_up_grace_check",
      sql`${t.catchUpGraceMinutes} > 0`,
    ),
    uniqueIndex("workflow_schedules_definition_node_idx").on(t.definitionId, t.nodeId),
  ],
);

/**
 * Occurrence ledger for schedule triggers, and the whole idempotency story:
 * the occurrence instant is computed from the cron expression, so re-evaluating
 * the same occurrence reproduces an identical primary key and the second write
 * is a conflict instead of a second run. No fallback identity and therefore no
 * bucket edge, unlike the webhook inbox, which has to hash the body into a
 * six-hour tumbling bucket when a sender omits a delivery id.
 *
 * Deliberately separate from webhook_trigger_deliveries and trigger_deliveries:
 * both of those are keyed by a caller-supplied delivery id and carry payload
 * columns a schedule has nothing to put in.
 *
 * The composite foreign key pins the version the occurrence was admitted under,
 * so a redeploy mid-wait cannot silently move an occurrence onto a newer graph.
 */
export const scheduleOccurrences = pgTable(
  "schedule_occurrences",
  {
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => workflowSchedules.id, { onDelete: "cascade" }),
    occurrenceAt: timestamp("occurrence_at", { withTimezone: true }).notNull(),
    definitionId: integer("definition_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    /**
     * True while this occurrence is still waiting to be dispatched. A row is
     * SETTLED when pending is false and outcome is not null, and settled is
     * terminal. An occurrence that is pending with a non-null skip_reason is not
     * settled: it carries an annotation about a failed or deferred attempt and the
     * drain will try it again.
     */
    pending: boolean("pending").notNull().default(false),
    outcome: text("outcome"),
    /** Machine-readable detail behind a settlement or a retryable annotation
     *  ("at_capacity", "overlap:<instant>", a provider message). Never cleared
     *  once written: a later writer coalesces onto it rather than nulling it, so
     *  the reason an occurrence ended is not overwritten by the reason it was
     *  finally settled. */
    skipReason: text("skip_reason"),
    /** How many older occurrences this row stands in for: the backlog the
     *  evaluator passed over plus any pending occurrence this one superseded. */
    droppedCount: integer("dropped_count").notNull().default(0),
    /** True when dropped_count is a floor rather than an exact number, because
     *  the evaluator stopped counting at its backlog cap. Without this column the
     *  cap would be recorded as an exact count, which would make the persistence
     *  layer invent a number the evaluator deliberately refused to invent. */
    droppedCountCapped: boolean("dropped_count_capped").notNull().default(false),
    /** How many dispatch attempts this occurrence has absorbed. Distinguishes
     *  "the drain never got to it" (0) from "it kept failing" (>1), which one
     *  overwritten skip_reason cannot. */
    attemptCount: integer("attempt_count").notNull().default(0),
    blockingRunId: text("blocking_run_id"),
    runId: text("run_id"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scheduleId, t.occurrenceAt] }),
    uniqueIndex("schedule_occurrences_one_pending_per_schedule_idx")
      .on(t.scheduleId)
      .where(sql`${t.pending} = true`),
    index("schedule_occurrences_run_id_idx").on(t.runId),
    check(
      "schedule_occurrences_outcome_check",
      // Spelled with the null branch even though a null check passes anyway: an
      // undecided occurrence is the normal pending state, not an oversight.
      //
      // There is deliberately no 'skipped_capacity': being at capacity is not a
      // decision about an occurrence, it is a reason it has not run YET. Settling
      // it would break the queue policy's promise that a due occurrence waits, so
      // capacity is recorded as an annotation on a still-pending row instead.
      sql`${t.outcome} is null or ${t.outcome} in ('started', 'skipped_overlap', 'skipped_stale', 'superseded', 'expired', 'cancelled', 'run_cancelled', 'error')`,
    ),
    foreignKey({
      columns: [t.definitionId, t.definitionVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "schedule_occurrences_definition_version_fk",
    }),
  ],
);

/**
 * Prompt library: one row per reusable prompt the dashboard manages. The
 * metadata here (name, description, tags) is mutable in place, while the prompt
 * text is append-only in prompt_library_versions, the same split
 * workflow_definitions uses. A prompt is archived (soft-deleted) via
 * archived_at; the partial unique index frees its name for reuse once archived.
 * Distinct from the read-only Arthur prompt registry served by /api/v1/prompts:
 * those are runtime agent prompts discovered from the codebase, these are
 * user-authored text blocks copied into workflow-definition block params.
 */
