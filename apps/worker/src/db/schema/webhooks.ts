import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workflowDefinitionVersions, workflowDefinitions } from "./definitions.js";

export const webhookTriggerEndpoints = pgTable(
  "webhook_trigger_endpoints",
  {
    id: text("id").primaryKey(),
    definitionId: integer("definition_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    authScheme: text("auth_scheme").notNull().default("hmac_sha256"),
    /** null means "the scheme's default header name", so changing that default
     *  does not require rewriting rows that never overrode it. */
    headerName: text("header_name"),
    /** Optional hmac_sha256 replay protection: when on, the signature must cover
     *  `${timestamp}.${rawBody}` and the timestamp must be fresh. */
    requireTimestamp: boolean("require_timestamp").notNull().default(false),
    /** null means "the default timestamp header name", mirroring headerName. */
    timestampHeader: text("timestamp_header"),
    timestampToleranceSeconds: integer("timestamp_tolerance_seconds")
      .notNull()
      .default(300),
    secretCiphertext: text("secret_ciphertext").notNull(),
    previousSecretCiphertext: text("previous_secret_ciphertext"),
    previousExpiresAt: timestamp("previous_expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "webhook_trigger_endpoints_auth_scheme_check",
      sql`${t.authScheme} in ('hmac_sha256', 'shared_token')`,
    ),
    check(
      "webhook_trigger_endpoints_timestamp_tolerance_check",
      sql`${t.timestampToleranceSeconds} > 0`,
    ),
    uniqueIndex("webhook_trigger_endpoints_definition_node_idx").on(
      t.definitionId,
      t.nodeId,
    ),
  ],
);

/** Authenticated, normalized webhook-delivery inbox. Delivery identity is
 * idempotent per endpoint; at most one row per subject is retained as pending
 * feedback. Deliberately separate from trigger_deliveries: that inbox is keyed
 * by provider and carries VCS-shaped columns this one has no meaning for. */
export const webhookTriggerDeliveries = pgTable(
  "webhook_trigger_deliveries",
  {
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookTriggerEndpoints.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    subjectKey: text("subject_key").notNull(),
    definitionId: integer("definition_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    pending: boolean("pending").notNull().default(false),
    result: jsonb("result").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.endpointId, t.deliveryId] }),
    uniqueIndex("webhook_trigger_deliveries_one_pending_per_subject_idx")
      .on(t.subjectKey)
      .where(sql`${t.pending} = true`),
    foreignKey({
      columns: [t.definitionId, t.definitionVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "webhook_trigger_deliveries_definition_version_fk",
    }),
  ],
);

/** Fixed-window request counter per endpoint. The window start is part of the
 * key, so an upsert is the whole rate-limit algorithm and expired windows are
 * simply rows nobody reads again. `kind` splits the budget in two: an "ingress"
 * counter charged before authentication (so a URL holder flooding junk cannot
 * burn unbounded CPU) and an "inbox" counter charged only after a valid
 * signature (so junk can never starve the real sender's budget). */
export const webhookTriggerRateLimits = pgTable(
  "webhook_trigger_rate_limits",
  {
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookTriggerEndpoints.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    kind: text("kind").notNull().default("inbox"),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.windowStart, t.kind] })],
);

/**
 * Per-day tally of deliveries refused before they became deliveries. A rejected
 * request (bad signature, unknown or revoked endpoint, oversized or unparsable
 * body, rate limit) never writes a webhook_trigger_deliveries row, so without
 * this table the operator reads a clean delivery log while the sender sees
 * nothing but errors. No foreign key on purpose: the endpoint id in a rejection
 * can be one that never existed, which is exactly the case worth surfacing.
 */
export const webhookTriggerRejectionCounters = pgTable(
  "webhook_trigger_rejection_counters",
  {
    endpointId: text("endpoint_id").notNull(),
    /** Floored to the day by the caller. */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.windowStart, t.reason] })],
);

/** Bounded, payload-free evidence for provider webhook health. One row per
 * provider/check/outcome/reason/day keeps authentication failures visible to
 * System Health without turning untrusted requests into an unbounded log. */
