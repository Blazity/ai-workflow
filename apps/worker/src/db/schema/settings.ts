import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import type { SettingValue } from "@shared/contracts";

/**
 * One row per setting an operator has actually decided.
 *
 * Absence is meaningful: a key with no row resolves from the environment and
 * then from the registry default, which is what keeps a deployment that has
 * never opened the Settings page behaving exactly as it did before this table
 * existed. The value is jsonb rather than text so a boolean, an integer, a
 * string and a list of strings round-trip as themselves.
 *
 * The column is nullable only in the SQL sense that a caller could write SQL
 * NULL; the writer always sends a jsonb value, so a cleared optional setting
 * is stored as the jsonb literal `null` and still counts as a stored row.
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<SettingValue>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
});

/**
 * Append-only log of every settings change, with who made it and why.
 *
 * `previousValue` is SQL NULL when the key had no row at all, and the jsonb
 * literal `null` when the key was stored as cleared. Both read back as null in
 * JavaScript, which is the one thing the history view cannot tell apart and
 * does not need to.
 */
export const settingsVersions = pgTable(
  "settings_versions",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    previousValue: jsonb("previous_value").$type<SettingValue>(),
    newValue: jsonb("new_value").$type<SettingValue>().notNull(),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("settings_versions_key_id_idx").on(table.key, table.id)],
);
