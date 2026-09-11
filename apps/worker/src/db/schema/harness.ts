import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
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
  HarnessCapabilityCatalog,
  HarnessProfileDraftManifest,
  HarnessProfileManifest,
} from "@shared/contracts";
import { organization } from "../auth-schema.js";

export const harnessProfileVersions = pgTable(
  "harness_profile_versions",
  {
    profileId: text("profile_id")
      .notNull()
      .references((): AnyPgColumn => harnessProfiles.id, {
        onDelete: "restrict",
      }),
    version: integer("version").notNull(),
    manifest: jsonb("manifest").$type<HarnessProfileManifest>().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdById: text("created_by_id").notNull(),
    restoredFromVersion: integer("restored_from_version"),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.version] }),
    uniqueIndex("harness_profile_versions_hash_unique").on(
      t.profileId,
      t.manifestHash,
    ),
    check("harness_profile_versions_version_check", sql`${t.version} > 0`),
  ],
);

export const harnessProfiles = pgTable(
  "harness_profiles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    slug: text("slug").notNull(),
    draftManifest: jsonb("draft_manifest")
      .$type<HarnessProfileDraftManifest>()
      .notNull(),
    draftRevision: integer("draft_revision").notNull().default(1),
    draftRestoredFromVersion: integer("draft_restored_from_version"),
    publishedVersion: integer("published_version"),
    system: boolean("system").notNull().default(false),
    readOnly: boolean("read_only").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdById: text("created_by_id").notNull(),
    updatedById: text("updated_by_id").notNull(),
  },
  (t) => [
    uniqueIndex("harness_profiles_org_slug_unique")
      .on(t.organizationId, t.slug)
      .where(sql`${t.organizationId} is not null`),
    uniqueIndex("harness_profiles_system_slug_unique")
      .on(t.slug)
      .where(sql`${t.organizationId} is null`),
    index("harness_profiles_organization_id_idx").on(t.organizationId),
    check(
      "harness_profiles_ownership_check",
      sql`(${t.system} = true and ${t.readOnly} = true and ${t.organizationId} is null) or (${t.system} = false and ${t.organizationId} is not null)`,
    ),
    check(
      "harness_profiles_draft_revision_check",
      sql`${t.draftRevision} > 0`,
    ),
    check(
      "harness_profiles_published_version_check",
      sql`${t.publishedVersion} is null or ${t.publishedVersion} > 0`,
    ),
    foreignKey({
      columns: [t.id, t.publishedVersion],
      foreignColumns: [
        harnessProfileVersions.profileId,
        harnessProfileVersions.version,
      ],
      name: "harness_profiles_published_version_fk",
    }).onDelete("restrict"),
  ],
);

/**
 * Organization-scoped, non-secret provider capability discovery cache.
 * Catalog rows are keyed by the exact CLI version used by an immutable
 * Harness Profile so a stale but safe catalog can still be inspected.
 */
export const harnessCapabilityCatalogs = pgTable(
  "harness_capability_catalogs",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    cliVersion: text("cli_version").notNull(),
    catalog: jsonb("catalog").$type<HarnessCapabilityCatalog>().notNull(),
    catalogHash: text("catalog_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    lastRefreshFailedAt: timestamp("last_refresh_failed_at", {
      withTimezone: true,
    }),
    lastRefreshError: text("last_refresh_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("harness_capability_catalogs_scope_unique").on(
      t.organizationId,
      t.provider,
      t.cliVersion,
    ),
    check(
      "harness_capability_catalogs_provider_check",
      sql`${t.provider} in ('claude', 'codex')`,
    ),
  ],
);

/**
 * Content-addressed, organization-private snapshots of imported skills. The
 * artifact hash covers the exact source, root path, file paths, modes, hashes,
 * and bytes.
 *
 * A row carries exactly one source variant: either the four GitHub columns, or
 * the two local ones describing a directory shipped with the deployment. The
 * variants are told apart by `sourceKind`, which lives here rather than inside
 * the hashed source payload: a discriminator inside that payload would rehash
 * every artifact already stored and unpin every profile pinning it. The shape
 * check makes a half-filled row unrepresentable.
 */
export const harnessSkillArtifacts = pgTable(
  "harness_skill_artifacts",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    artifactHash: text("artifact_hash").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sourceKind: text("source_kind").notNull().default("github"),
    sourceOwner: text("source_owner"),
    sourceRepository: text("source_repository"),
    sourcePath: text("source_path"),
    sourceCommitSha: text("source_commit_sha"),
    localPath: text("local_path"),
    localContentSha256: text("local_content_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdById: text("created_by_id").notNull(),
  },
  (t) => [
    uniqueIndex("harness_skill_artifacts_org_hash_unique").on(
      t.organizationId,
      t.artifactHash,
    ),
    index("harness_skill_artifacts_source_idx").on(
      t.organizationId,
      t.sourceOwner,
      t.sourceRepository,
      t.sourcePath,
    ),
    check(
      "harness_skill_artifacts_source_kind_check",
      sql`${t.sourceKind} in ('github', 'local')`,
    ),
    check(
      "harness_skill_artifacts_source_shape_check",
      sql`(
        ${t.sourceKind} <> 'github'
        or (
          ${t.sourceOwner} is not null
          and ${t.sourceRepository} is not null
          and ${t.sourcePath} is not null
          and ${t.sourceCommitSha} is not null
          and ${t.localPath} is null
          and ${t.localContentSha256} is null
        )
      ) and (
        ${t.sourceKind} <> 'local'
        or (
          ${t.localPath} is not null
          and ${t.localContentSha256} is not null
          and ${t.sourceOwner} is null
          and ${t.sourceRepository} is null
          and ${t.sourcePath} is null
          and ${t.sourceCommitSha} is null
        )
      )`,
    ),
  ],
);

export const harnessSkillArtifactFiles = pgTable(
  "harness_skill_artifact_files",
  {
    artifactId: integer("artifact_id")
      .notNull()
      .references(() => harnessSkillArtifacts.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    mode: integer("mode").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    contentBase64: text("content_base64").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.path] }),
    check(
      "harness_skill_artifact_files_mode_check",
      sql`${t.mode} in (420, 493)`,
    ),
    check(
      "harness_skill_artifact_files_size_check",
      sql`${t.sizeBytes} >= 0`,
    ),
  ],
);

export const harnessProfileVersionSkills = pgTable(
  "harness_profile_version_skills",
  {
    profileId: text("profile_id").notNull(),
    profileVersion: integer("profile_version").notNull(),
    artifactId: integer("artifact_id")
      .notNull()
      .references(() => harnessSkillArtifacts.id, { onDelete: "restrict" }),
    skillName: text("skill_name").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.profileId, t.profileVersion, t.artifactId],
    }),
    foreignKey({
      columns: [t.profileId, t.profileVersion],
      foreignColumns: [
        harnessProfileVersions.profileId,
        harnessProfileVersions.version,
      ],
      name: "harness_profile_version_skills_profile_version_fk",
    }).onDelete("restrict"),
    uniqueIndex("harness_profile_version_skills_name_unique").on(
      t.profileId,
      t.profileVersion,
      t.skillName,
    ),
    uniqueIndex("harness_profile_version_skills_position_unique").on(
      t.profileId,
      t.profileVersion,
      t.position,
    ),
    check(
      "harness_profile_version_skills_position_check",
      sql`${t.position} >= 0`,
    ),
  ],
);
