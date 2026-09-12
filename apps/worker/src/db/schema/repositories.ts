import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  RepositoryCatalogSource,
  RepositoryRelationship,
} from "@shared/contracts";

/**
 * Every repository this deployment knows about, whether or not the agent may
 * touch it.
 *
 * The row is the identity and the switch; everything an operator edits lives on
 * the append-only profile versions below, so a change to a repository's rules
 * or its script groups is a new version rather than an overwrite, and the run
 * that is in flight can still say which version its checks ran under.
 *
 * `currentProfileVersion` is denormalized on purpose. It is what the upsert CTE
 * increments to mint the next version in one statement (neon-http has no
 * interactive transactions), and what every read joins on to resolve "the
 * current profile" without a correlated max() per repository. 0 means the row
 * exists but has never been given a profile: an allowlist seed or an import
 * creates rows in exactly that state.
 */
export const repositories = pgTable(
  "repositories",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    /** `owner/name`, in the operator's own casing. Matching is case
     *  insensitive everywhere it decides access; the stored casing is what the
     *  composed check configuration carries, because the workspace has always
     *  matched check configuration on the exact string. */
    path: text("path").notNull(),
    displayName: text("display_name").notNull().default(""),
    defaultBranch: text("default_branch").notNull().default(""),
    description: text("description").notNull().default(""),
    rules: text("rules").notNull().default(""),
    relationships: jsonb("relationships")
      .$type<RepositoryRelationship[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    enabled: boolean("enabled").notNull().default(true),
    source: text("source").$type<RepositoryCatalogSource>().notNull(),
    currentProfileVersion: integer("current_profile_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("repositories_provider_path_unique").on(t.provider, t.path),
    check("repositories_provider_check", sql`${t.provider} in ('github', 'gitlab')`),
    check(
      "repositories_source_check",
      sql`${t.source} in ('imported', 'manual', 'seeded', 'migrated')`,
    ),
  ],
);

/**
 * Every change to a repository's profile, append-only, with who made it and
 * why.
 *
 * `scriptGroups` holds the repository scripts entry for this repository alone,
 * exactly as it was submitted. Verbatim, because the publication gate
 * fingerprints stored bytes and normalizing on the way in would invalidate
 * every recorded gate on a save that changed nothing an operator typed; that
 * normalization stays where it has always been, at the engine boundary.
 */
export const repositoryProfileVersions = pgTable(
  "repository_profile_versions",
  {
    id: serial("id").primaryKey(),
    repositoryId: integer("repository_id")
      .notNull()
      .references((): AnyPgColumn => repositories.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    description: text("description").notNull().default(""),
    rules: text("rules").notNull().default(""),
    relationships: jsonb("relationships")
      .$type<RepositoryRelationship[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    scriptGroups: jsonb("script_groups").$type<Record<string, unknown>>(),
    gateGroups: jsonb("gate_groups").$type<string[]>(),
    actorId: text("actor_id").notNull(),
    actorLabel: text("actor_label").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("repository_profile_versions_unique").on(t.repositoryId, t.version),
    check("repository_profile_versions_version_check", sql`${t.version} > 0`),
  ],
);

/**
 * Whether the catalog decides access yet: one row, never more.
 *
 * A flag rather than a row count, because "the table happens to be empty" and
 * "the operator has not switched this on" are different states and only the
 * second may keep the agent unrestricted. While it is false the catalog reports
 * the bridge and answers "enabled" for every repository the installation can
 * reach, which is exactly how a deployment behaves today. No migration, no
 * import and no seed ever flips it to true on a deployment that was
 * unrestricted; the seed sets it only on a deployment whose allowlist variable
 * was already restricting it.
 */
export const repositoryCatalogState = pgTable(
  "repository_catalog_state",
  {
    id: integer("id").primaryKey().default(1),
    activated: boolean("activated").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedById: text("activated_by_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("repository_catalog_state_single_row", sql`${t.id} = 1`)],
);
