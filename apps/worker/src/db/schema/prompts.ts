import { sql } from "drizzle-orm";
import {
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
  PromptSlotDefinition,
} from "@shared/contracts";

export const promptLibrary = pgTable(
  "prompt_library",
  {
    id: serial("id").primaryKey(),
    /** Immutable reference key used by {{prompt:<slug>}} tokens; derived from
     *  the name at create time, never changed by renames. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id").notNull(),
    createdByLabel: text("created_by_label").notNull(),
  },
  (t) => [
    uniqueIndex("prompt_library_name_active_idx")
      .on(t.name)
      .where(sql`${t.archivedAt} is null`),
    uniqueIndex("prompt_library_slug_active_idx")
      .on(t.slug)
      .where(sql`${t.archivedAt} is null`),
  ],
);

/**
 * Prompt library versions, append-only per prompt. Each row belongs to a
 * prompt_library row; a prompt's head is its highest version, and a restore
 * appends a copy of an older body with restored_from_version set. The body
 * lives here (never mutated) so the version history is the audit trail, while
 * the parent row carries only mutable metadata.
 */
export const promptLibraryVersions = pgTable(
  "prompt_library_versions",
  {
    promptId: integer("prompt_id")
      .notNull()
      .references(() => promptLibrary.id),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    slots: jsonb("slots")
      .$type<PromptSlotDefinition[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id").notNull(),
    createdByLabel: text("created_by_label").notNull(),
    restoredFromVersion: integer("restored_from_version"),
  },
  (t) => [primaryKey({ columns: [t.promptId, t.version] })],
);

/**
 * Harness profiles split mutable draft state from immutable published
 * versions. System profiles are global and read-only; organization profiles
 * are tenant-owned and all store access must scope them to organization_id.
 */
