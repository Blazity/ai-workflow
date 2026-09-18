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
import type { WorkScopeAnswerReading, WorkScopeAskedRepository } from "@shared/contracts";

/** One human question suspended inside its asking Workflow run. */
export const clarificationRequests = pgTable(
  "clarification_requests",
  {
    id: text("id").primaryKey(),
    ticketKey: text("ticket_key"),
    subjectKey: text("subject_key"),
    runId: text("run_id").notNull(),
    blockId: text("block_id"),
    definitionId: integer("definition_id"),
    definitionVersion: integer("definition_version"),
    questions: jsonb("questions").$type<string[]>().notNull(),
    suggestedAnswers: jsonb("suggested_answers").$type<string[]>(),
    /** Written when the question is asked, because the answer path receives
     *  only the row and the catalog may have changed by then, so neither the
     *  repository nor the reason it was asked can be recovered later. */
    askedRepositories: jsonb("asked_repositories").$type<WorkScopeAskedRepository[]>(),
    status: text("status").notNull().default("preparing"),
    hookToken: text("hook_token"),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    answer: text("answer"),
    /**
     * HOW THOSE WORDS WERE READ, decided once when the answer arrived.
     *
     * The record and the resumed run used to read `answer` separately and reach
     * opposite conclusions about the same sentence. This is the single reading
     * both now consume, written in the same statement as the words it reads, so
     * a row can never hold an answer nobody has read.
     *
     * Null on every row answered before this column existed, and on every
     * question that was not about repositories. Both mean the same thing to a
     * reader: there is nothing stored here, fall back to what you did before.
     */
    answerReading: jsonb("answer_reading").$type<WorkScopeAnswerReading>(),
    answeredById: text("answered_by_id"),
    answeredByLabel: text("answered_by_label"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    snapshotId: text("snapshot_id"),
    sourceSandboxId: text("source_sandbox_id"),
    snapshotExpiresAt: timestamp("snapshot_expires_at", { withTimezone: true }),
    cleanupState: text("cleanup_state").notNull().default("none"),
    cleanupError: text("cleanup_error"),
    /** Reserved deliveries of the stored answer to the suspended run. Bounded,
     *  so a resume that cannot succeed stops being retried and reaches a human. */
    resumeAttempts: integer("resume_attempts").default(0),
  },
  (t) => [
    index("clarification_requests_status_idx").on(t.status),
    index("clarification_requests_ticket_key_idx").on(t.ticketKey),
    index("clarification_requests_run_id_idx").on(t.runId),
    index("clarification_requests_expiry_idx").on(t.status, t.expiresAt),
    uniqueIndex("clarification_requests_hook_token_idx").on(t.hookToken),
    uniqueIndex("clarification_requests_pending_subject_idx")
      .on(t.subjectKey)
      .where(sql`${t.status} = 'pending'`),
  ],
);
