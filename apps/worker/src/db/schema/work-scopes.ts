import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  WorkScopeActor,
  WorkScopeEntryState,
  WorkScopeOrigin,
  WorkScopeTrailEvent,
  WorkScopeUnavailableReason,
} from "@shared/contracts";

/**
 * One row per subject of work that has a work scope, holding only the version.
 *
 * The version is what a person's edit compares against, and it lives apart
 * from the entries because the entries are one row per repository: a counter
 * on each entry could not say "nothing on this subject moved since you read
 * it", which is the only question the edit asks. Every applied write moves it
 * by exactly one, from a run or a person.
 */
export const workScopes = pgTable("work_scopes", {
  subjectKey: text("subject_key").primaryKey(),
  version: integer("version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Which repositories a subject's work touches, one row per repository.
 *
 * A row per key rather than a list in one field, because two runs on one
 * ticket write at once and a list rewritten whole by each would lose the other
 * run's decision. `origin_rank` is persisted beside `origin` so the write
 * statement itself can refuse a lower origin overwriting a higher one.
 */
export const workScopeEntries = pgTable(
  "work_scope_entries",
  {
    subjectKey: text("subject_key")
      .notNull()
      .references((): AnyPgColumn => workScopes.subjectKey),
    repositoryKey: text("repository_key").notNull(),
    state: text("state").$type<WorkScopeEntryState>().notNull(),
    unavailableReason: text("unavailable_reason").$type<WorkScopeUnavailableReason>(),
    origin: text("origin").$type<WorkScopeOrigin>().notNull(),
    originRank: smallint("origin_rank").notNull(),
    rationale: text("rationale").notNull(),
    decidedBy: jsonb("decided_by").$type<WorkScopeActor>().notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectKey, t.repositoryKey] }),
    check(
      "work_scope_entries_state_check",
      sql`${t.state} in ('selected', 'excluded', 'unavailable')`,
    ),
    check(
      "work_scope_entries_unavailable_reason_check",
      sql`${t.unavailableReason} in ('not_enabled', 'unusable')`,
    ),
    // Both directions: a reason on a selected entry would be read by nobody and
    // then trusted by whoever reads it next.
    check(
      "work_scope_entries_unavailable_reason_pairing_check",
      sql`(${t.unavailableReason} is not null) = (${t.state} = 'unavailable')`,
    ),
    check(
      "work_scope_entries_origin_check",
      sql`${t.origin} in ('person', 'workflow_owned_branch', 'ticket_text', 'trigger_policy', 'inferred')`,
    ),
    check("work_scope_entries_origin_rank_check", sql`${t.originRank} between 0 and 4`),
  ],
);

/**
 * The append-only decision trail: why the entries say what they say, and what
 * a run did with repositories when it has no subject to record them on.
 *
 * A row carries a subject, a run, or both, never neither: a panel edit has no
 * run and a schedule run has no subject. `repository_key` repeats the event's
 * single repository, when it names one, so "everything about this repository"
 * is a column filter rather than a scan of the event documents.
 */
export const workScopeTrail = pgTable(
  "work_scope_trail",
  {
    id: serial("id").primaryKey(),
    subjectKey: text("subject_key"),
    runId: text("run_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").$type<WorkScopeTrailEvent["kind"]>().notNull(),
    repositoryKey: text("repository_key"),
    event: jsonb("event").$type<WorkScopeTrailEvent>().notNull(),
  },
  (t) => [
    check(
      "work_scope_trail_kind_check",
      sql`${t.kind} in ('entry_written', 'entry_removed', 'question_asked', 'question_answered', 'request_refused', 'map_shown')`,
    ),
    check(
      "work_scope_trail_subject_or_run_check",
      sql`${t.subjectKey} is not null or ${t.runId} is not null`,
    ),
    index("work_scope_trail_subject_idx").on(t.subjectKey, t.id),
    index("work_scope_trail_run_idx").on(t.runId, t.id),
    // An answer is recorded once per clarification. The answer service can be
    // retried with the same answer after a lost response, and the insert that
    // meets this index is what stops the retry writing entries a second time.
    uniqueIndex("work_scope_trail_answer_once")
      .on(sql`(${t.event} ->> 'clarificationId')`)
      .where(sql`${t.kind} = 'question_answered'`),
    // A question is recorded once per clarification, for the same reason and by
    // the same means. The step that creates the clarification retries, and the
    // append that meets this index is what keeps a retried attempt from saying
    // the question was asked twice. It does not make the ASK idempotent: a
    // retried attempt writes a second clarification with an id of its own, and
    // its own, equally truthful, row.
    uniqueIndex("work_scope_trail_asked_once")
      .on(sql`(${t.event} ->> 'clarificationId')`)
      .where(sql`${t.kind} = 'question_asked'`),
  ],
);
