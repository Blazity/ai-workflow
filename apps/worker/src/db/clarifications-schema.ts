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
import type { WorkScopeAskedRepository } from "@shared/contracts";

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
