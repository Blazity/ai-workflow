import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Clarification queue: one row per set of questions a run parked on because the
 * agent needed human input before it could continue. The run records status
 * "awaiting" and inserts a pending row; the dashboard lists pending rows and
 * posts an answer, which dispatches a fresh clarification_answered resume run.
 *
 * The partial unique index keeps at most one pending row per ticket, and it is
 * the only thing that can: this deployment uses the neon-http driver, which has
 * no interactive transactions, so createClarificationRequest supersedes the
 * current pending row and then inserts the new one as two separate statements.
 * The index is what still guarantees a re-pickup of the same ticket can never
 * leave two live clarifications competing for one resume. Do not "restore" a
 * transaction here: it passes the pglite tests and fails in production.
 */
export const clarificationRequests = pgTable(
  "clarification_requests",
  {
    id: text("id").primaryKey(),
    ticketKey: text("ticket_key").notNull(),
    /** Run that asked the questions. */
    runId: text("run_id").notNull(),
    /** Graph node that raised the questions; null for the built-in default graph. */
    blockId: text("block_id"),
    /**
     * Definition the asking run belonged to. Nullable because clarifications can
     * come from the built-in default definition, which has no stored row.
     */
    definitionId: integer("definition_id"),
    /** Head version of that definition when the questions were filed. */
    definitionVersion: integer("definition_version"),
    questions: jsonb("questions").$type<string[]>().notNull(),
    suggestedAnswers: jsonb("suggested_answers").$type<string[]>(),
    status: text("status").notNull().default("pending"),
    askedAt: timestamp("asked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    answer: text("answer"),
    answeredById: text("answered_by_id"),
    answeredByLabel: text("answered_by_label"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /** Resume run started when the questions were answered (the clarification_answered run). */
    dispatchedRunId: text("dispatched_run_id"),
  },
  (t) => [
    index("clarification_requests_status_idx").on(t.status),
    index("clarification_requests_ticket_key_idx").on(t.ticketKey),
    index("clarification_requests_run_id_idx").on(t.runId),
    uniqueIndex("clarification_requests_pending_ticket_idx")
      .on(t.ticketKey)
      .where(sql`${t.status} = 'pending'`),
  ],
);
