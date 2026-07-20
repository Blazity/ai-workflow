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
    // Transitional read compatibility for rows written by the merged PR 118
    // checkpoint implementation. No new hook clarification writes these fields;
    // the migration squash removes them after the compatibility tests are gone.
    ownerToken: text("owner_token"),
    checkpointState: text("checkpoint_state"),
    workspaceManifest: jsonb("workspace_manifest"),
    successorOwnerToken: text("successor_owner_token"),
    dispatchedRunId: text("dispatched_run_id"),
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
