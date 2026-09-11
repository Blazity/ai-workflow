import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const activeRuns = pgTable(
  "active_runs",
  {
    subjectKey: text("subject_key").primaryKey(),
    ticketKey: text("ticket_key"),
    ownerToken: text("owner_token").notNull(),
    runId: text("run_id"),
    state: text("state").notNull().default("reserved"),
    runKind: text("run_kind").notNull().default("ticket"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "active_runs_state_check",
      sql`${t.state} in ('reserved', 'bound', 'parking', 'parked', 'cancelling')`,
    ),
    check(
      "active_runs_state_run_id_check",
      sql`(${t.state} = 'reserved' and ${t.runId} is null) or (${t.state} in ('bound', 'parking', 'parked') and ${t.runId} is not null) or ${t.state} = 'cancelling'`,
    ),
    index("active_runs_ticket_key_idx").on(t.ticketKey),
    uniqueIndex("active_runs_subject_owner_idx").on(t.subjectKey, t.ownerToken),
  ],
);

/** Every scratch/code sandbox owned by a run, not merely the most recent one. */
export const activeRunSandboxes = pgTable(
  "active_run_sandboxes",
  {
    subjectKey: text("subject_key").notNull(),
    ownerToken: text("owner_token").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectKey, t.ownerToken, t.sandboxId] }),
    foreignKey({
      columns: [t.subjectKey, t.ownerToken],
      foreignColumns: [activeRuns.subjectKey, activeRuns.ownerToken],
      name: "active_run_sandboxes_subject_owner_fk",
    }).onDelete("cascade"),
  ],
);

/** Authenticated, normalized provider-event inbox. Delivery identity is
 * idempotent; at most one row per subject is retained as pending feedback. */

export const failedTickets = pgTable("failed_tickets", {
  ticketKey: text("ticket_key").primaryKey(),
  runId: text("run_id").notNull(),
  error: text("error").notNull(),
  /** ISO-8601 string, exactly as FailedTicketMeta.failedAt round-trips today. */
  failedAt: text("failed_at").notNull(),
});

/**
 * At-capacity dispatch queue (AIW-277). One row per ticket the poll refused
 * because every run slot was taken. Mirrors the failed_tickets tombstone shape
 * (PK ticket_key) so a ticket keyed here gets an at-capacity comment
 * at-least-once, effectively-once per episode (the residual gap: a Jira POST
 * that lands but whose confirmed_at write is lost lets a later tick re-post).
 *
 * Suppression/lease semantics use ONLY attempted_at and confirmed_at:
 * - confirmed_at set  = a Jira comment was CONFIRMED sent → suppress further ones.
 * - confirmed_at NULL = never confirmed; attempted_at is a short claim lease so
 *   two overlapping poll ticks don't both send, and a row whose Jira call failed
 *   (attempted_at set, confirmed_at still NULL) is retried by a later tick.
 * queued_at is display-only: it feeds the dashboard "waiting" duration and never
 * gates the lease. The row is dropped when the ticket dispatches or a human
 * moves it out of the AI column (episode over); re-entry re-inserts a fresh one.
 */

export const threadParents = pgTable("thread_parents", {
  ticketKey: text("ticket_key").primaryKey(),
  messageId: text("message_id").notNull(),
});

/**
 * Post-PR gate lock - replaces gate:lock:{repo}#{pr} (SET NX EX 30).
 * An expired row counts as released; acquire atomically steals it.
 */
