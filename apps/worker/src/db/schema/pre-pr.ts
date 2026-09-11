import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type {
  PrePrCheckRepositoryConfig,
} from "@shared/contracts";

type StoredPrePrCheckConfig = {
  repositories: Array<PrePrCheckRepositoryConfig & { commands: string[] }>;
};

export const prePrCheckConfigVersions = pgTable("pre_pr_check_config_versions", {
  version: serial("version").primaryKey(),
  config: jsonb("config").$type<StoredPrePrCheckConfig>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: text("created_by_id").notNull(),
  createdByLabel: text("created_by_label").notNull(),
  restoredFromVersion: integer("restored_from_version"),
});

/**
 * Dashboard-managed workflow definition versions, append-only per definition.
 * Declared before workflowDefinitions so that table can express its composite
 * deployed pointer. The typed lazy reference keeps the reverse FK cycle safe.
 */
