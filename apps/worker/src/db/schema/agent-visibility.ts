import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { clarificationRequests } from "../clarifications-schema.js";

/**
 * What one send gave a model, and what became of every answer to a repository
 * question. Written by capture (`run-observability/agent-briefings.ts`) and by
 * the answer path (`services/agent-visibility/`), read by the dashboard and
 * MCP through one read model.
 *
 * Every write here is ONE statement: production runs neon-http, which cannot
 * open a transaction (`db/client.ts`), and a briefing must never be readable
 * without the texts it points at.
 */

/**
 * Section texts and repository-context documents, stored once by the sha256 of
 * the STORED text.
 *
 * Every planning pass repeats the ticket, the comments and the map, and runs
 * on one repository repeat its AGENTS.md, so the same text is written once and
 * pointed at by every briefing that sent it.
 *
 * `last_referenced_at` is what makes the sweep safe without a transaction:
 * every capture statement bumps it on the rows it points at, so a DELETE that
 * has already read an old value re-evaluates the updated row and leaves it
 * alone (`deleteExpiredAgentBriefings`).
 */
export const agentBriefingTexts = pgTable(
  "agent_briefing_texts",
  {
    sha256: text("sha256").primaryKey(),
    text: text("text").notNull(),
    bytes: integer("bytes").notNull(),
    lastReferencedAt: timestamp("last_referenced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("agent_briefing_texts_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("agent_briefing_texts_bytes_check", sql`${t.bytes} >= 0`),
  ],
);

/**
 * One row per send: the briefing it produced, or the marker saying why there
 * is none.
 *
 * The identity is the four-part Block Attempt key plus a sequence number in
 * send order, which is what the read model joins on: the attempt row's id is a
 * serial that never leaves its closure. `INSERT ... ON CONFLICT DO NOTHING`
 * makes a replayed step a no-op, and `content_sha256` is what tells a repeat
 * of the same send from a different briefing written under the same identity.
 *
 * `expires_at` is the later of the run's replay expiry and thirty days from the
 * send, and the sweep asks the run row again: a briefing never outlives the
 * replay that reaches it, and one captured by a run whose replay has already
 * expired is not born expired.
 */
export const agentBriefings = pgTable(
  "agent_briefings",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    attempt: integer("attempt").notNull(),
    activationScopeId: text("activation_scope_id").notNull(),
    sequence: integer("sequence").notNull(),
    /** `discovery`, `agent` or `llm`, as the package writes it. */
    kind: text("kind").notNull(),
    /** `captured`, or why nothing was: `capture_disabled` (switched off when
     *  this send happened), `capture_skipped` (the record was refused). */
    capture: text("capture").notNull(),
    /** The package's index; null on a marker row. */
    briefingIndex: jsonb("briefing_index"),
    /** The sha256 of the stored index WITHOUT its capture time, so a second
     *  write of the same send is told from a different briefing under the same
     *  identity: a re-executed step stamps a new time for the same content. */
    contentSha256: text("content_sha256"),
    /** Every text this index points at, for the sweep to release. */
    textSha256s: text("text_sha256s").array().notNull(),
    /** The index and the texts it points at, in UTF-8 bytes. */
    bytes: integer("bytes").notNull(),
    /** Why a send was not recorded, in one sanitized sentence. */
    detail: text("detail"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_briefings_identity_unique").on(
      t.runId,
      t.nodeId,
      t.attempt,
      t.activationScopeId,
      t.sequence,
    ),
    index("agent_briefings_expires_at_idx").on(t.expiresAt),
    // The sweep asks which briefings still point at a text; without this it
    // would read every briefing's array on every poll.
    index("agent_briefings_text_sha256s_idx").using("gin", t.textSha256s),
    check("agent_briefings_kind_check", sql`${t.kind} in ('discovery', 'agent', 'llm')`),
    check(
      "agent_briefings_capture_check",
      sql`${t.capture} in ('captured', 'capture_disabled', 'capture_skipped')`,
    ),
    check("agent_briefings_attempt_check", sql`${t.attempt} > 0`),
    check("agent_briefings_sequence_check", sql`${t.sequence} > 0`),
    // A briefing is its index: a captured row without one would read as a send
    // whose prompt we kept and cannot show.
    check(
      "agent_briefings_captured_index_check",
      sql`(${t.capture} = 'captured') = (${t.briefingIndex} is not null and ${t.contentSha256} is not null)`,
    ),
  ],
);

/**
 * What a run's capture did, kept after its briefings expire.
 *
 * Attempt rows and briefings go with the replay observations at thirty days,
 * and then "why is there no briefing" would read as "this code could not
 * capture" for every run ever recorded.
 *
 * THE ROW'S EXISTENCE IS THE CAPABILITY. It is written by capture-capable
 * code, on every outcome that code can reach: a send recorded, a send whose
 * write failed, a detector that refused, capture switched off, a second
 * briefing under one identity. So a run that tried and lost says "capture
 * failed" rather than "this run predates capture", which is what a person
 * would otherwise be told exactly when something else has already gone wrong.
 * A replayed send bumps nothing: it is the same send arriving again.
 */
export const agentBriefingRuns = pgTable("agent_briefing_runs", {
  runId: text("run_id").primaryKey(),
  capturedCount: integer("captured_count").notNull().default(0),
  disabledCount: integer("disabled_count").notNull().default(0),
  /** A send the detector refused to store. */
  skippedCount: integer("skipped_count").notNull().default(0),
  /** A send whose write was lost (the database was unreachable, the statement
   *  failed): the send happened and nothing kept it. */
  failedCount: integer("failed_count").notNull().default(0),
  /** A send that found a different briefing already stored under its identity. */
  conflictCount: integer("conflict_count").notNull().default(0),
  firstRecordedAt: timestamp("first_recorded_at", { withTimezone: true }).notNull().defaultNow(),
  lastRecordedAt: timestamp("last_recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every arrival of an answer to a clarification: the words as delivered, who
 * delivered them, through which surface, how they were read and what was
 * posted back.
 *
 * CONSECUTIVE IDENTICAL ARRIVALS ARE ONE ROW WITH A COUNT. The Jira path
 * re-composes the answer out of the ticket's comments on every poll tick, so a
 * row per tick would bury a round under a weekend of retries; A, B, A stays
 * three rows, in that order.
 *
 * `previous_id` is the row this one followed (0 for the first), and it is
 * unique per clarification: that is what stops a webhook and a poll composing
 * the same words at the same moment from writing two adjacent identical rows,
 * without a transaction to serialize them.
 *
 * They outlive the replay: a round is the history of a person's decision, not
 * of a run's execution.
 */
export const clarificationAnswerDeliveries = pgTable(
  "clarification_answer_deliveries",
  {
    id: serial("id").primaryKey(),
    clarificationId: text("clarification_id")
      .notNull()
      .references(() => clarificationRequests.id, { onDelete: "cascade" }),
    previousId: integer("previous_id").notNull(),
    words: text("words").notNull(),
    /** `person` or `several_people`, as the package's vocabulary writes it. */
    authorKind: text("author_kind").notNull(),
    authorDisplay: text("author_display").notNull(),
    /** `jira`, `dashboard`, `mcp` or `other`: where the words really arrived,
     *  never guessed from a label. */
    surface: text("surface").notNull(),
    /** The one reading of these words, or null for a question that was not
     *  about repositories. */
    reading: jsonb("reading"),
    /** What was posted back to the person, or null when nothing was. */
    note: text("note"),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [
    uniqueIndex("clarification_answer_deliveries_chain_unique").on(t.clarificationId, t.previousId),
    index("clarification_answer_deliveries_clarification_idx").on(t.clarificationId, t.id),
    check(
      "clarification_answer_deliveries_author_kind_check",
      sql`${t.authorKind} in ('person', 'several_people')`,
    ),
    check(
      "clarification_answer_deliveries_surface_check",
      sql`${t.surface} in ('jira', 'dashboard', 'mcp', 'other')`,
    ),
    check("clarification_answer_deliveries_count_check", sql`${t.count} >= 1`),
    check("clarification_answer_deliveries_previous_check", sql`${t.previousId} >= 0`),
    check("clarification_answer_deliveries_time_check", sql`${t.lastAt} >= ${t.firstAt}`),
  ],
);
