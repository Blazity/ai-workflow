import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  MAX_MEMORY_ANCHORS,
  MAX_MEMORY_AREA_CANDIDATES,
  type MemoryAreaStatus,
  type MemoryEntryStatus,
  type MemoryOpenDispute,
  type MemoryStateKind,
  type MemoryTopic,
  type MemoryTrust,
} from "./memory-vocabulary.js";

/**
 * Where an entry lives and how far it is trusted: folder, area, trust, pin and
 * status, one row per entry of a store.
 *
 * Keyed by a stable `entry_key`, with `(subject, kind, text_hash)` as its
 * current alias: an update, or a store rewriting the entry itself, moves the
 * alias to the new text's hash and keeps the key, so a human's trust and pin
 * survive a change of text. A forget deletes the row. No text is held here:
 * the stores hold it, the ledger (`memory_events`) keeps its history.
 *
 * A missing row reads as topic `other`, area `unresolved`, trust `learned`
 * (`derived` for a derived origin), status `active`, not pinned; the core
 * holds that default, not the database.
 *
 * `version` moves by one on every applied write, so a writer that read the
 * row can refuse to overwrite a change it did not see. Every write is ONE
 * statement, together with its ledger rows (neon-http has no transactions).
 *
 * The words (`kind`, `topic`, `area_status`, `trust`, `status`) are plain
 * text, checked in code against `memory-vocabulary.ts`, so a later stage adds
 * a word without a migration.
 */
export const memoryEntryState = pgTable(
  "memory_entry_state",
  {
    entryKey: uuid("entry_key").primaryKey().defaultRandom(),
    subject: text("subject").notNull(),
    kind: text("kind").$type<MemoryStateKind>().notNull(),
    textHash: text("text_hash").notNull(),
    /** The entry's id in each store that holds it, by store id. */
    storeIds: jsonb("store_ids").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    topic: text("topic").$type<MemoryTopic>().notNull(),
    area: text("area").notNull(),
    areaStatus: text("area_status").$type<MemoryAreaStatus>().notNull(),
    areaCandidates: text("area_candidates").array().notNull().default(sql`'{}'::text[]`),
    module: text("module"),
    anchors: text("anchors").array().notNull().default(sql`'{}'::text[]`),
    trust: text("trust").$type<MemoryTrust>().notNull(),
    pinned: boolean("pinned").notNull().default(false),
    status: text("status").$type<MemoryEntryStatus>().notNull(),
    statusReason: text("status_reason"),
    statusSince: timestamp("status_since", { withTimezone: true }).notNull().defaultNow(),
    openDisputes: jsonb("open_disputes")
      .$type<MemoryOpenDispute[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    relearnedUnseen: integer("relearned_unseen").notNull().default(0),
    originRunId: text("origin_run_id"),
    originTicket: text("origin_ticket"),
    lastAdmittedAt: timestamp("last_admitted_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The current alias. Unique, so two entries never answer to one text.
    uniqueIndex("memory_entry_state_alias_unique").on(t.subject, t.kind, t.textHash),
    // Forget by text hash, whatever the subject.
    index("memory_entry_state_text_hash_idx").on(t.textHash),
    check("memory_entry_state_text_hash_check", sql`${t.textHash} ~ '^[0-9a-f]{64}$'`),
    check("memory_entry_state_store_ids_check", sql`jsonb_typeof(${t.storeIds}) = 'object'`),
    check(
      "memory_entry_state_area_candidates_check",
      sql`cardinality(${t.areaCandidates}) <= ${sql.raw(String(MAX_MEMORY_AREA_CANDIDATES))}`,
    ),
    check(
      "memory_entry_state_anchors_check",
      sql`cardinality(${t.anchors}) <= ${sql.raw(String(MAX_MEMORY_ANCHORS))}`,
    ),
    check("memory_entry_state_open_disputes_check", sql`jsonb_typeof(${t.openDisputes}) = 'array'`),
    check("memory_entry_state_relearned_unseen_check", sql`${t.relearnedUnseen} >= 0`),
    check("memory_entry_state_version_check", sql`${t.version} >= 1`),
  ],
);
