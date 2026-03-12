import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

// Enums

export const ticketSourceEnum = pgEnum("ticket_source", ["jira", "linear"]);

export const ticketStatusEnum = pgEnum("ticket_status", [
  "queued",
  "in_progress",
  "clarifying",
  "in_review",
  "done",
  "failed",
]);

export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "provisioning",
  "running",
  "reviewing",
  "fixing",
  "merging",
  "completed",
  "failed",
  "cancelled",
]);

export const agentRunTriggerEnum = pgEnum("agent_run_trigger", [
  "new",
  "review_fix",
  "clarification_answer",
]);

// Tables

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    externalId: text("external_id").notNull(),
    source: ticketSourceEnum("source").notNull(),
    status: ticketStatusEnum("status").notNull().default("queued"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("tickets_external_id_source_unique").on(t.externalId, t.source)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id),
    status: agentRunStatusEnum("status").notNull().default("provisioning"),
    trigger: agentRunTriggerEnum("trigger").notNull(),
    branchName: text("branch_name"),
    containerId: text("container_id"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("agent_runs_ticket_id_idx").on(t.ticketId)],
);
