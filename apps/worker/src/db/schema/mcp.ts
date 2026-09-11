import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "../auth-schema.js";

export type McpIdempotencyState = "started" | "completed" | "failed";

export type McpIdempotencyRow = {
  organizationId: string;
  actorSubject: string;
  clientId: string;
  toolName: string;
  idempotencyKey: string;
  payloadHash: string;
  state: McpIdempotencyState;
  safeResponse: unknown | null;
  errorCode: string | null;
  expiresAt: Date;
};

export type McpAuditEventRow = {
  id: string;
  requestId: string;
  traceId: string;
  organizationId: string;
  actorSubject: string;
  clientId: string;
  role: "owner" | "admin" | "member" | "service";
  scopes: string[];
  toolName: string;
  mutationClass: "read" | "direct" | "confirmed";
  targetRefs: string[];
  inputHash: string;
  outputHash: string | null;
  idempotencyKeyHash: string | null;
  outcome: "attempted" | "success" | "rejected" | "failed";
  errorCode: string | null;
  latencyMs: number;
  serverVersion: string;
  contractHash: string;
  occurredAt: Date;
};

export type McpRateLimitWindowRow = {
  organizationId: string;
  actorSubject: string;
  clientId: string;
  toolName: string;
  windowStartedAt: Date;
  requestCount: number;
  expiresAt: Date;
};

export const mcpIdempotencyKeys = pgTable(
  "mcp_idempotency_keys",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorSubject: text("actor_subject").notNull(),
    clientId: text("client_id").notNull(),
    toolName: text("tool_name").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    state: text("state").$type<McpIdempotencyState>().notNull(),
    safeResponse: jsonb("safe_response").$type<unknown>(),
    errorCode: text("error_code"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("mcp_idempotency_keys_namespace_unique").on(
      table.organizationId,
      table.actorSubject,
      table.clientId,
      table.toolName,
      table.idempotencyKey,
    ),
    index("mcp_idempotency_keys_expires_at_idx").on(table.expiresAt),
    check(
      "mcp_idempotency_keys_state_check",
      sql`${table.state} in ('started', 'completed', 'failed')`,
    ),
  ],
);

export const mcpAuditEvents = pgTable(
  "mcp_audit_events",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    traceId: text("trace_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorSubject: text("actor_subject").notNull(),
    clientId: text("client_id").notNull(),
    role: text("role").$type<McpAuditEventRow["role"]>().notNull(),
    scopes: text("scopes").array().notNull(),
    toolName: text("tool_name").notNull(),
    mutationClass: text("mutation_class")
      .$type<McpAuditEventRow["mutationClass"]>()
      .notNull(),
    targetRefs: text("target_refs").array().notNull(),
    inputHash: text("input_hash").notNull(),
    outputHash: text("output_hash"),
    idempotencyKeyHash: text("idempotency_key_hash"),
    outcome: text("outcome").$type<McpAuditEventRow["outcome"]>().notNull(),
    errorCode: text("error_code"),
    latencyMs: integer("latency_ms").notNull(),
    serverVersion: text("server_version").notNull(),
    contractHash: text("contract_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("mcp_audit_events_organization_occurred_at_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
    index("mcp_audit_events_request_id_idx").on(table.requestId),
  ],
);

export const mcpRateLimitWindows = pgTable(
  "mcp_rate_limit_windows",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorSubject: text("actor_subject").notNull(),
    clientId: text("client_id").notNull(),
    toolName: text("tool_name").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull(),
    // Writers set this to two full rate-limit windows after windowStartedAt.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.actorSubject,
        table.clientId,
        table.toolName,
        table.windowStartedAt,
      ],
    }),
    index("mcp_rate_limit_windows_expires_at_idx").on(table.expiresAt),
  ],
);

/** One owner-CAS reservation per provider-neutral workflow subject. */
