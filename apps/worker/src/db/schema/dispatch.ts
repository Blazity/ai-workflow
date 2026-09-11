import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workflowDefinitionVersions } from "./definitions.js";

export const triggerDeliveries = pgTable(
  "trigger_deliveries",
  {
    provider: text("provider").notNull(),
    deliveryId: text("delivery_id").notNull(),
    producer: text("producer").notNull(),
    /** Stable identity of the human action behind this delivery. One review's
     * fan-out of N webhooks shares one key so it accepts exactly one run. */
    semanticKey: text("semantic_key"),
    triggerType: text("trigger_type").notNull(),
    subjectKey: text("subject_key").notNull(),
    ticketKey: text("ticket_key"),
    headSha: text("head_sha").notNull(),
    definitionId: integer("definition_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    pending: boolean("pending").notNull().default(false),
    result: jsonb("result").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.deliveryId] }),
    uniqueIndex("trigger_deliveries_one_pending_per_subject_idx")
      .on(t.subjectKey)
      .where(sql`${t.pending} = true`),
    uniqueIndex("trigger_deliveries_semantic_key_idx")
      .on(t.provider, t.semanticKey)
      .where(sql`${t.semanticKey} is not null`),
    foreignKey({
      columns: [t.definitionId, t.definitionVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "trigger_deliveries_definition_version_fk",
    }),
  ],
);

export const manualDispatchRequests = pgTable(
  "manual_dispatch_requests",
  {
    requestId: text("request_id").primaryKey(),
    payloadHash: text("payload_hash").notNull(),
    definitionId: integer("definition_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    triggerNodeId: text("trigger_node_id").notNull(),
    triggerType: text("trigger_type").notNull(),
    inputKind: text("input_kind").notNull(),
    subjectKey: text("subject_key").notNull(),
    ticketKey: text("ticket_key"),
    inputPayload: jsonb("input_payload").$type<Record<string, unknown>>().notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorLabel: text("actor_label").notNull(),
    ownerToken: text("owner_token"),
    runId: text("run_id"),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "manual_dispatch_requests_status_check",
      sql`${t.status} in ('pending', 'reserved', 'prepared', 'candidate_started', 'started', 'failed')`,
    ),
    check(
      "manual_dispatch_requests_input_kind_check",
      sql`${t.inputKind} in ('ticket', 'pull_request')`,
    ),
    index("manual_dispatch_requests_status_idx").on(t.status),
    index("manual_dispatch_requests_subject_key_idx").on(t.subjectKey),
    index("manual_dispatch_requests_run_id_idx").on(t.runId),
    foreignKey({
      columns: [t.definitionId, t.definitionVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "manual_dispatch_requests_definition_version_fk",
    }),
  ],
);

/** Replaces blazebot:failed-tickets - FailedTicketMeta as typed columns. */

export const dispatchCapacityQueue = pgTable("dispatch_capacity_queue", {
  ticketKey: text("ticket_key").primaryKey(),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});

/**
 * Replaces blazebot:thread-parents. Separate table on purpose: thread
 * parents survive across runs for the same ticket (unregister must not
 * clear them). text column = no more Upstash number-coercion of Slack ts.
 */
