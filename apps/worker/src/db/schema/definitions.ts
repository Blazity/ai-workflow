import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  WorkflowDefinitionLayoutInput,
} from "@shared/contracts";

export const workflowDefinitionVersions = pgTable(
  "workflow_definition_versions",
  {
    definitionId: integer("definition_id")
      .notNull()
      .references((): AnyPgColumn => workflowDefinitions.id),
    version: integer("version").notNull(),
    // Stored rows may predate required normalized node fields. Reads parse and
    // upgrade this raw JSON before exposing the canonical WorkflowDefinition.
    definition: jsonb("definition").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id").notNull(),
    createdByLabel: text("created_by_label").notNull(),
    restoredFromVersion: integer("restored_from_version"),
  },
  (t) => [primaryKey({ columns: [t.definitionId, t.version] })],
);

/**
 * Pre-image audit of every loop carry schema that migration 0051 (AIW-245)
 * rewrote in place. The resync matches a stored carry schema by value against a
 * known prior platform shape, but value alone cannot prove the stored copy was
 * the platform's rather than a customer's step output that happens to be the
 * same shape. So before rewriting, the migration records the exact coordinate
 * and the before-value here, giving an operator the rows changed and the value
 * to revert. The primary key doubles as the idempotency key: the pre-image
 * INSERT is ON CONFLICT DO NOTHING, so re-running the migration captures nothing
 * new. No foreign key, deliberately: the audit must survive a later delete of
 * the version row it describes.
 */
export const carrySchemaResyncAudit = pgTable(
  "carry_schema_resync_audit",
  {
    definitionId: integer("definition_id").notNull(),
    version: integer("version").notNull(),
    /** 0-based index into the definition's nodes array. */
    nodeIndex: integer("node_index").notNull(),
    nodeId: text("node_id"),
    /** 0-based index into the loop node's configuration.carry array. */
    carryIndex: integer("carry_index").notNull(),
    /** Which EMBEDDED_SCHEMA_SOURCES entry the before-value matched. */
    sourceKey: text("source_key").notNull(),
    beforeSchema: jsonb("before_schema").$type<unknown>().notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.definitionId, t.version, t.nodeIndex, t.carryIndex],
    }),
  ],
);

/**
 * Named workflow definitions: one row per definition the dashboard manages.
 * trigger_types is denormalized from the head version, kept in sync by
 * save/restore, and backs the one-enabled-definition-per-trigger rule so the
 * overlap check is a plain array-overlap query instead of re-parsing every
 * head version's graph. A definition is archived (soft-deleted) via
 * archived_at; the partial unique index frees its name for reuse once archived.
 */
export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    triggerTypes: text("trigger_types")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Canvas geometry is CAS-patched independently from semantic edits. */
    layout: jsonb("layout")
      .$type<WorkflowDefinitionLayoutInput>()
      .notNull()
      .default(sql`'{"nodes":{}}'::jsonb`),
    layoutRevision: integer("layout_revision").notNull().default(0),
    /** Exact immutable snapshot selected for new dispatches. */
    deployedVersion: integer("deployed_version"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id").notNull(),
    createdByLabel: text("created_by_label").notNull(),
  },
  (t) => [
    uniqueIndex("workflow_definitions_name_active_idx")
      .on(t.name)
      .where(sql`${t.archivedAt} is null`),
    foreignKey({
      columns: [t.id, t.deployedVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "workflow_definitions_deployed_version_fk",
    }),
  ],
);

/**
 * Enabled trigger bindings - the DB-level guarantee behind "at most one enabled
 * definition per trigger type". One row per trigger_type currently owned by an
 * enabled, non-archived definition. trigger_type is the PRIMARY KEY, so a second
 * definition trying to claim the same trigger fails with a unique violation
 * (surfaced as the 409 "already handled" path) instead of racing past a
 * read-then-write overlap check.
 *
 * Rows exist ONLY while the owning definition is enabled, so their presence IS
 * the "enabled = true" predicate - a plain PK on trigger_type is equivalent to a
 * partial unique index on trigger_type WHERE enabled. A definition with several
 * trigger nodes gets several rows; enabling inserts them, disabling/archiving
 * deletes them, saving a new version re-syncs them to the head graph, and
 * getEnabledWorkflowDefinitionForTrigger repairs any drift (from a crashed
 * write) on read. ON DELETE CASCADE keeps a binding subordinate to its
 * definition.
 */
export const workflowDefinitionTriggers = pgTable("workflow_definition_triggers", {
  triggerType: text("trigger_type").primaryKey(),
  definitionId: integer("definition_id")
    .notNull()
    .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
});

/**
 * One authenticated ingress per webhook trigger node. The id doubles as the
 * public URL path segment, so it is a random opaque value and never the
 * definition id: guessing another tenant's endpoint must not be possible.
 * Secrets live here encrypted (AES-256-GCM under WEBHOOK_TRIGGER_ENCRYPTION_KEY)
 * and are never returned in cleartext after creation. A rotation writes the
 * outgoing secret to previous_secret_ciphertext and keeps accepting it until
 * previous_expires_at, so a caller can be updated without a failed delivery.
 * ON DELETE CASCADE keeps an endpoint subordinate to its definition.
 */
