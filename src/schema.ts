import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

// Enums

export const ticketSourceEnum = pgEnum("ticket_source", ["jira", "linear"]);

export const workflowStateEnum = pgEnum("workflow_state", [
  "queued",
  "implementing",
  "clarification_pending",
  "awaiting_review",
  "fixing_feedback",
  "completed",
  "failed",
]);

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "preparing_sandbox",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "clarification_needed",
]);

export const runTypeEnum = pgEnum("run_type", [
  "implementation",
  "review_fix",
  "conflict_resolution",
]);

// Tables

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    externalId: text("external_id").notNull(),
    identifier: text("identifier").notNull(),
    source: ticketSourceEnum("source").notNull(),
    state: text("state"),
    workflowState: workflowStateEnum("workflow_state")
      .notNull()
      .default("queued"),
    assignee: text("assignee"),
    branchName: text("branch_name"),
    prId: text("pr_id"),
    currentRunId: uuid("current_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("tickets_external_id_source_unique").on(t.externalId, t.source),
  ],
);

export const runAttempts = pgTable(
  "run_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id),
    attemptNumber: integer("attempt_number").notNull().default(1),
    type: runTypeEnum("type").notNull(),
    status: runStatusEnum("status").notNull().default("pending"),
    containerId: text("container_id"),
    branchName: text("branch_name"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [index("run_attempts_ticket_id_idx").on(t.ticketId)],
);
