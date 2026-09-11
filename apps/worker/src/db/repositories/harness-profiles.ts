import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  max,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type {
  HarnessProfileDraftManifest,
  HarnessProfileDto,
  HarnessProfileManifest,
  HarnessProfileReference,
  HarnessProfileVersionDto,
  HarnessSkillSource,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  type HarnessProvider,
} from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import {
  harnessProfiles,
  harnessProfileVersions,
  harnessProfileVersionSkills,
  harnessSkillArtifactFiles,
  harnessSkillArtifacts,
} from "../schema.js";

const VERSION_LIST_LIMIT = 50;
export interface HarnessProfileActor {
  organizationId: string;
  role?: string;
  id: string;
}

export class HarnessProfileStoreError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type ProfileSelect = typeof harnessProfiles.$inferSelect;
type VersionSelect = typeof harnessProfileVersions.$inferSelect;
type SkillArtifactSelect = typeof harnessSkillArtifacts.$inferSelect;

/**
 * The single place where a stored skill artifact row becomes a source object
 * from the contract.
 *
 * Every source column is nullable in the schema because each variant fills
 * only its own. On a row of either kind the matching columns are nonetheless
 * guaranteed to be filled, and not by convention: the
 * `harness_skill_artifacts_source_shape_check` constraint added in migration
 * 0046 rejects any row that claims a kind without the complete set. The checks
 * below restate that constraint rather than assuming it, so if the constraint
 * is ever dropped the failure surfaces here instead of as a `null` silently
 * reaching the artifact hash.
 *
 * A row of a kind this function does not know throws rather than returning
 * null: every caller needs a source it can hand straight to the contract, so a
 * nullable return would make each of them invent its own error for a case none
 * of them can act on.
 */
export function readHarnessSkillArtifactSource(
  artifact: SkillArtifactSelect,
): HarnessSkillSource {
  if (artifact.sourceKind === "local") {
    const { localPath, localContentSha256 } = artifact;
    if (localPath === null || localContentSha256 === null) {
      throw new Error(
        "Skill artifact claims the local source kind but is missing columns " +
          "that harness_skill_artifacts_source_shape_check should have required.",
      );
    }
    return { path: localPath, contentSha256: localContentSha256 };
  }
  if (artifact.sourceKind !== "github") {
    throw new Error(
      `Skill artifact source kind '${artifact.sourceKind}' is unknown.`,
    );
  }
  const { sourceOwner, sourceRepository, sourcePath, sourceCommitSha } =
    artifact;
  if (
    sourceOwner === null ||
    sourceRepository === null ||
    sourcePath === null ||
    sourceCommitSha === null
  ) {
    throw new Error(
      "Skill artifact claims the GitHub source kind but is missing columns " +
        "that harness_skill_artifacts_source_shape_check should have required.",
    );
  }
  return {
    owner: sourceOwner,
    repository: sourceRepository,
    path: sourcePath,
    commitSha: sourceCommitSha,
  };
}

function mapProfile(row: ProfileSelect): HarnessProfileDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    system: row.system,
    readOnly: row.readOnly,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    draftRevision: row.draftRevision,
    draftRestoredFromVersion: row.draftRestoredFromVersion,
    publishedVersion: row.publishedVersion,
    draft: structuredClone(row.draftManifest),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdById: row.createdById,
    updatedById: row.updatedById,
  };
}

function mapVersion(row: VersionSelect): HarnessProfileVersionDto {
  return {
    profileId: row.profileId,
    version: row.version,
    manifest: structuredClone(row.manifest),
    manifestHash: row.manifestHash,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    restoredFromVersion: row.restoredFromVersion,
  };
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function visibleProfileCondition(organizationId: string) {
  return or(
    eq(harnessProfiles.organizationId, organizationId),
    and(isNull(harnessProfiles.organizationId), eq(harnessProfiles.system, true)),
  );
}

function writableProfileCondition(input: {
  organizationId: string;
  profileId: string;
}) {
  return and(
    eq(harnessProfiles.id, input.profileId),
    eq(harnessProfiles.organizationId, input.organizationId),
    eq(harnessProfiles.system, false),
    eq(harnessProfiles.readOnly, false),
  );
}

export async function insertSystemHarnessProfile(
  db: Db,
  input: {
    profileId: string;
    slug: string;
    draft: HarnessProfileDraftManifest;
    actorId: string;
  },
): Promise<void> {
  await db
    .insert(harnessProfiles)
    .values({
      id: input.profileId,
      organizationId: null,
      slug: input.slug,
      draftManifest: input.draft,
      draftRevision: 1,
      publishedVersion: null,
      system: true,
      readOnly: true,
      createdById: input.actorId,
      updatedById: input.actorId,
    })
    .onConflictDoNothing({ target: harnessProfiles.id });
}

async function getSystemHarnessProfile(
  db: Db,
  profileId: string,
): Promise<ProfileSelect | null> {
  const [profile] = await db
    .select()
    .from(harnessProfiles)
    .where(
      and(
        eq(harnessProfiles.id, profileId),
        isNull(harnessProfiles.organizationId),
        eq(harnessProfiles.system, true),
        eq(harnessProfiles.readOnly, true),
      ),
    )
    .limit(1);
  return profile ?? null;
}

async function getLatestSystemHarnessProfileVersion(
  db: Db,
  profileId: string,
): Promise<VersionSelect | null> {
  const [version] = await db
    .select()
    .from(harnessProfileVersions)
    .where(eq(harnessProfileVersions.profileId, profileId))
    .orderBy(desc(harnessProfileVersions.version))
    .limit(1);
  return version ?? null;
}

export async function getSystemHarnessProfileVersion(
  db: Db,
  input: { profileId: string; version: number },
): Promise<VersionSelect | null> {
  const [version] = await db
    .select()
    .from(harnessProfileVersions)
    .where(
      and(
        eq(harnessProfileVersions.profileId, input.profileId),
        eq(harnessProfileVersions.version, input.version),
      ),
    )
    .limit(1);
  return version ?? null;
}

export async function insertSystemHarnessProfileVersion(
  db: Db,
  input: {
    profileId: string;
    version: number;
    manifest: HarnessProfileManifest;
    manifestHash: string;
    actorId: string;
  },
): Promise<VersionSelect | null> {
  const [version] = await db
    .insert(harnessProfileVersions)
    .values({
      profileId: input.profileId,
      version: input.version,
      manifest: input.manifest,
      manifestHash: input.manifestHash,
      createdById: input.actorId,
    })
    .onConflictDoNothing()
    .returning();
  return version ?? null;
}

export async function updateSystemHarnessProfile(
  db: Db,
  input: {
    profileId: string;
    slug: string;
    draft: HarnessProfileDraftManifest;
    publishedVersion: number;
    actorId: string;
  },
): Promise<void> {
  await db
    .update(harnessProfiles)
    .set({
      slug: input.slug,
      draftManifest: input.draft,
      draftRevision: sql<number>`CASE
        WHEN ${harnessProfiles.draftManifest} IS DISTINCT FROM ${JSON.stringify(input.draft)}::jsonb
          THEN ${harnessProfiles.draftRevision} + 1
        ELSE ${harnessProfiles.draftRevision}
      END`,
      publishedVersion: input.publishedVersion,
      updatedAt: new Date(),
      updatedById: input.actorId,
    })
    .where(
      and(
        eq(harnessProfiles.id, input.profileId),
        isNull(harnessProfiles.organizationId),
        eq(harnessProfiles.system, true),
        eq(harnessProfiles.readOnly, true),
        notExists(
          db
            .select({ one: sql`1` })
            .from(harnessProfileVersions)
            .where(
              and(
                eq(harnessProfileVersions.profileId, input.profileId),
                gt(harnessProfileVersions.version, input.publishedVersion),
              ),
            ),
        ),
      ),
    );
}

export async function listHarnessProfiles(
  db: Db,
  input: { organizationId: string; includeArchived?: boolean },
): Promise<HarnessProfileDto[]> {
  const condition = visibleProfileCondition(input.organizationId);
  const rows = await db
    .select()
    .from(harnessProfiles)
    .where(
      input.includeArchived
        ? condition
        : and(condition, isNull(harnessProfiles.archivedAt)),
    )
    .orderBy(desc(harnessProfiles.system), asc(harnessProfiles.slug))
    .limit(500);
  return rows.map(mapProfile);
}

export async function getCurrentSystemHarnessProfileReference(
  db: Db,
  provider: HarnessProvider,
): Promise<HarnessProfileReference> {
  const profileId = BUILTIN_HARNESS_PROFILE_IDS[provider];
  const [row] = await db
    .select({ publishedVersion: harnessProfiles.publishedVersion })
    .from(harnessProfiles)
    .where(
      and(
        eq(harnessProfiles.id, profileId),
        isNull(harnessProfiles.organizationId),
        eq(harnessProfiles.system, true),
        eq(harnessProfiles.readOnly, true),
      ),
    )
    .limit(1);
  if (!row?.publishedVersion) {
    throw new HarnessProfileStoreError(
      500,
      `System harness profile ${profileId} has no published version`,
    );
  }
  return { profileId, version: row.publishedVersion };
}

/** Process-bound lookup for definition authoring. The service receives a
 * reference, never a database capability. */
export function getConnectedCurrentSystemHarnessProfileReference(
  provider: HarnessProvider,
): Promise<HarnessProfileReference> {
  return getCurrentSystemHarnessProfileReference(getDb(), provider);
}

export async function getHarnessProfile(
  db: Db,
  input: {
    organizationId: string;
    profileId: string;
  },
): Promise<ProfileSelect | null> {
  const [row] = await db
    .select()
    .from(harnessProfiles)
    .where(
      and(
        eq(harnessProfiles.id, input.profileId),
        visibleProfileCondition(input.organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listHarnessProfileVersions(
  db: Db,
  input: { organizationId: string; profileId: string },
): Promise<HarnessProfileVersionDto[]> {
  const profile = await getHarnessProfile(db, input);
  if (!profile) return [];
  const rows = await db
    .select()
    .from(harnessProfileVersions)
    .where(eq(harnessProfileVersions.profileId, profile.id))
    .orderBy(desc(harnessProfileVersions.version))
    .limit(VERSION_LIST_LIMIT);
  return rows.map(mapVersion);
}

export async function getHarnessProfileVersion(
  db: Db,
  input: {
    organizationId: string;
    profileId: string;
    version: number;
  },
): Promise<HarnessProfileVersionDto | null> {
  const profile = await getHarnessProfile(db, input);
  if (!profile) return null;
  const [row] = await db
    .select()
    .from(harnessProfileVersions)
    .where(
      and(
        eq(harnessProfileVersions.profileId, profile.id),
        eq(harnessProfileVersions.version, input.version),
      ),
    )
    .limit(1);
  return row ? mapVersion(row) : null;
}

/** Raw immutable version row for authoring policy; no manifest interpretation. */
export async function getHarnessProfileVersionRaw(
  db: Db,
  input: { organizationId: string; profileId: string; version: number },
): Promise<VersionSelect | null> {
  const profile = await getHarnessProfile(db, input);
  if (!profile) return null;
  const [row] = await db
    .select()
    .from(harnessProfileVersions)
    .where(and(eq(harnessProfileVersions.profileId, profile.id), eq(harnessProfileVersions.version, input.version)))
    .limit(1);
  return row ?? null;
}

/** Writes a draft prepared by the authoring tier under the existing CAS. */
export async function replaceHarnessProfileDraftPrepared(
  db: Db,
  input: {
    organizationId: string;
    profileId: string;
    expectedRevision: number;
    actorId: string;
    draft: HarnessProfileDraftManifest;
    restoredFromVersion: number | null;
  },
): Promise<HarnessProfileDto | null> {
  const [updated] = await db
    .update(harnessProfiles)
    .set({
      draftManifest: input.draft,
      draftRevision: sql`${harnessProfiles.draftRevision} + 1`,
      draftRestoredFromVersion: input.restoredFromVersion,
      updatedAt: new Date(),
      updatedById: input.actorId,
    })
    .where(and(
      writableProfileCondition({ organizationId: input.organizationId, profileId: input.profileId }),
      eq(harnessProfiles.draftRevision, input.expectedRevision),
      isNull(harnessProfiles.archivedAt),
    ))
    .returning();
  return updated ? mapProfile(updated) : null;
}

/**
 * Reads the source of every skill the draft pins. The manifest carries only a
 * hash and a name, so this is the only way the dashboard can tell a skill
 * shipped by the deployment from one fetched out of GitHub.
 *
 * Selecting the artifact rows directly rather than through
 * `getHarnessSkillArtifactsByHashes` is deliberate: that path loads and
 * verifies every file blob, which a detail view has no use for and which would
 * make one corrupt artifact break the whole page. File contents live in a
 * separate table, so these rows are metadata only.
 *
 * A hash with no matching row is dropped rather than raised: a draft is not
 * foreign-keyed to the artifact table, and a dangling pin must not take the
 * detail view down with it.
 */
export async function insertHarnessProfile(
  db: Db,
  input: {
    slug: string;
    draft: HarnessProfileDraftManifest;
    actor: HarnessProfileActor;
  },
): Promise<ProfileSelect> {
  const [row] = await db
      .insert(harnessProfiles)
      .values({
        id: randomUUID(),
        organizationId: input.actor.organizationId,
        slug: input.slug,
        draftManifest: input.draft,
        createdById: input.actor.id,
        updatedById: input.actor.id,
      })
    .returning();
  return row!;
}

export async function replaceHarnessProfileDraft(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    draft: HarnessProfileDraftManifest;
    actor: HarnessProfileActor;
  },
): Promise<ProfileSelect | null> {
  const [updated] = await db
    .update(harnessProfiles)
    .set({
      draftManifest: input.draft,
      draftRevision: sql`${harnessProfiles.draftRevision} + 1`,
      updatedAt: new Date(),
      updatedById: input.actor.id,
    })
    .where(
      and(
        writableProfileCondition({
          organizationId: input.actor.organizationId,
          profileId: input.profileId,
        }),
        eq(harnessProfiles.draftRevision, input.expectedRevision),
        isNull(harnessProfiles.archivedAt),
      ),
  )
    .returning();
  return updated ?? null;
}

async function getLatestHarnessProfileVersionNumber(
  db: Db,
  profileId: string,
): Promise<number> {
  const [latest] = await db
    .select({ version: max(harnessProfileVersions.version) })
    .from(harnessProfileVersions)
    .where(eq(harnessProfileVersions.profileId, profileId));
  return latest?.version ?? 0;
}

export async function publishHarnessProfilePrepared(
  db: Db,
  input: {
    organizationId: string;
    profileId: string;
    expectedRevision: number;
    expectedPublishedVersion: number | null;
    restoredFromVersion: number | null;
    actorId: string;
    version: number;
    manifest: HarnessProfileManifest;
    manifestHash: string;
    skills: Array<{ artifactId: number; name: string; position: number }>;
  },
): Promise<{ profileId: string; version: number } | null> {
  const skillRows = input.skills.map((skill) => {
    return sql`(${skill.artifactId}::integer, ${skill.name}::text, ${skill.position}::integer)`;
  });
  const insertedSkillsCte =
    skillRows.length === 0
      ? sql``
      : sql`, inserted_skills AS (
          INSERT INTO harness_profile_version_skills
            (profile_id, profile_version, artifact_id, skill_name, position)
          SELECT inserted.profile_id, inserted.version,
            skill.artifact_id, skill.skill_name, skill.position
          FROM inserted_version inserted
          CROSS JOIN (
            VALUES ${sql.join(skillRows, sql`, `)}
          ) AS skill(artifact_id, skill_name, position)
          RETURNING profile_id
        )`;
  const skillBarrier =
    skillRows.length === 0
      ? sql``
      : sql`CROSS JOIN (SELECT count(*) FROM inserted_skills) AS skill_barrier`;
  const result = await db.execute(sql`
      WITH claimed_profile AS (
        UPDATE harness_profiles
        SET published_version = ${input.version},
            draft_restored_from_version = NULL,
            updated_at = now(),
            updated_by_id = ${input.actorId}
        WHERE id = ${input.profileId}
          AND organization_id = ${input.organizationId}
          AND system = false
          AND read_only = false
          AND archived_at IS NULL
          AND draft_revision = ${input.expectedRevision}
          AND published_version IS NOT DISTINCT FROM ${input.expectedPublishedVersion}
        RETURNING id
      ), inserted_version AS (
        INSERT INTO harness_profile_versions
          (
            profile_id,
            version,
            manifest,
            manifest_hash,
            created_by_id,
            restored_from_version
          )
        SELECT claimed.id,
          ${input.version},
          ${JSON.stringify(input.manifest)}::jsonb,
          ${input.manifestHash},
          ${input.actorId},
          ${input.restoredFromVersion}
        FROM claimed_profile claimed
        RETURNING profile_id, version
      )
      ${insertedSkillsCte}
      SELECT inserted.profile_id AS "profileId", inserted.version
      FROM inserted_version inserted
      JOIN claimed_profile claimed ON claimed.id = inserted.profile_id
      ${skillBarrier}
    `);
  return rawRows<{ profileId: string; version: number }>(result)[0] ?? null;
}

export const mapHarnessProfileRow = mapProfile;
export const mapHarnessProfileVersionRow = mapVersion;

export async function archiveHarnessProfileRaw(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
): Promise<ProfileSelect | null> {
  const [updated] = await db
    .update(harnessProfiles)
    .set({
      archivedAt: new Date(),
      draftRevision: sql`${harnessProfiles.draftRevision} + 1`,
      updatedAt: new Date(),
      updatedById: input.actor.id,
    })
    .where(
      and(
        writableProfileCondition({
          organizationId: input.actor.organizationId,
          profileId: input.profileId,
        }),
        eq(harnessProfiles.draftRevision, input.expectedRevision),
        isNull(harnessProfiles.archivedAt),
      ),
  )
    .returning();
  return updated ?? null;
}

export async function restoreArchivedHarnessProfileRaw(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
): Promise<ProfileSelect | null> {
  const [updated] = await db
      .update(harnessProfiles)
      .set({
        archivedAt: null,
        draftRevision: sql`${harnessProfiles.draftRevision} + 1`,
        updatedAt: new Date(),
        updatedById: input.actor.id,
      })
      .where(
        and(
          writableProfileCondition({
            organizationId: input.actor.organizationId,
            profileId: input.profileId,
          }),
          eq(harnessProfiles.draftRevision, input.expectedRevision),
          sql`${harnessProfiles.archivedAt} IS NOT NULL`,
        ),
      )
    .returning();
  return updated ?? null;
}

async function hasHarnessProfileVersions(
  db: Db,
  profileId: string,
): Promise<boolean> {
  const [version] = await db
    .select({ version: harnessProfileVersions.version })
    .from(harnessProfileVersions)
    .where(eq(harnessProfileVersions.profileId, profileId))
    .limit(1);
  return version !== undefined;
}

export async function deleteUnpublishedHarnessProfile(
  db: Db,
  input: {
    profileId: string;
    organizationId: string;
    expectedRevision: number;
  },
): Promise<boolean> {
  const [deleted] = await db
    .delete(harnessProfiles)
    .where(
      and(
        eq(harnessProfiles.id, input.profileId),
        eq(harnessProfiles.organizationId, input.organizationId),
        eq(harnessProfiles.draftRevision, input.expectedRevision),
        eq(harnessProfiles.system, false),
        eq(harnessProfiles.readOnly, false),
        isNull(harnessProfiles.publishedVersion),
      ),
    )
    .returning({ id: harnessProfiles.id });
  return deleted !== undefined;
}

export async function resolveHarnessProfileVersionRaw(
  db: Db,
  input: {
    organizationId: string;
    profileId: string;
    version: number;
  },
): Promise<{
  manifest: HarnessProfileManifest;
  manifestHash: string;
  artifacts: Array<typeof harnessSkillArtifacts.$inferSelect>;
  files: Array<typeof harnessSkillArtifactFiles.$inferSelect>;
  skillNames: string[];
} | null> {
  if (!Number.isInteger(input.version) || input.version < 1) return null;
  const rows = await db
    .select({
      profile: harnessProfiles,
      version: harnessProfileVersions,
      artifact: harnessSkillArtifacts,
      file: harnessSkillArtifactFiles,
      skillName: harnessProfileVersionSkills.skillName,
      position: harnessProfileVersionSkills.position,
    })
    .from(harnessProfileVersions)
    .innerJoin(
      harnessProfiles,
      eq(harnessProfiles.id, harnessProfileVersions.profileId),
    )
    .leftJoin(
      harnessProfileVersionSkills,
      and(
        eq(harnessProfileVersionSkills.profileId, harnessProfileVersions.profileId),
        eq(harnessProfileVersionSkills.profileVersion, harnessProfileVersions.version),
      ),
    )
    .leftJoin(
      harnessSkillArtifacts,
      and(
        eq(harnessSkillArtifacts.id, harnessProfileVersionSkills.artifactId),
        eq(harnessSkillArtifacts.organizationId, input.organizationId),
      ),
    )
    .leftJoin(
      harnessSkillArtifactFiles,
      eq(harnessSkillArtifactFiles.artifactId, harnessSkillArtifacts.id),
    )
    .where(
      and(
        eq(harnessProfileVersions.profileId, input.profileId),
        eq(harnessProfileVersions.version, input.version),
        visibleProfileCondition(input.organizationId),
      ),
    )
    .orderBy(
      asc(harnessProfileVersionSkills.position),
      asc(harnessSkillArtifactFiles.path),
    );
  const row = rows[0];
  if (!row) return null;
  const artifacts = Array.from(
    new Map(
      rows
        .filter((candidate) => candidate.artifact !== null)
        .map((candidate) => [candidate.artifact!.id, candidate.artifact!]),
    ).values(),
  );
  const files = Array.from(
    new Map(
      rows
        .filter((candidate) => candidate.file !== null)
        .map((candidate) => [
          `${candidate.file!.artifactId}\0${candidate.file!.path}`,
          candidate.file!,
        ]),
    ).values(),
  ).sort((left, right) =>
    left.artifactId - right.artifactId || left.path.localeCompare(right.path)
  );
  return {
    manifest: structuredClone(row.version.manifest),
    manifestHash: row.version.manifestHash,
    artifacts,
    files,
    skillNames: Array.from(
      new Map(
        rows
          .filter((candidate) => candidate.artifact !== null && candidate.skillName !== null)
          .map((candidate) => [candidate.position!, candidate.skillName!]),
      ).values(),
    ),
  };
}

export async function getHarnessSkillArtifactsByHashes(
  db: Db,
  input: {
    organizationId: string;
    artifactHashes: string[];
  },
): Promise<Array<typeof harnessSkillArtifacts.$inferSelect>> {
  if (input.artifactHashes.length === 0) return [];
  const artifacts = await db
    .select()
    .from(harnessSkillArtifacts)
    .where(
      and(
        eq(harnessSkillArtifacts.organizationId, input.organizationId),
        inArray(harnessSkillArtifacts.artifactHash, input.artifactHashes),
      ),
    );
  return artifacts;
}

/**
 * Raw artifact rows and their immutable file blobs.  Consumers that make a
 * policy decision (publish and runtime resolution) verify this envelope in
 * their own tier; the repository deliberately does not interpret it.
 */
export async function getHarnessSkillArtifactEnvelopeByHashes(
  db: Db,
  input: {
    organizationId: string;
    artifactHashes: string[];
  },
): Promise<{
  artifacts: Array<typeof harnessSkillArtifacts.$inferSelect>;
  files: Array<typeof harnessSkillArtifactFiles.$inferSelect>;
}> {
  if (input.artifactHashes.length === 0) return { artifacts: [], files: [] };
  const rows = await db
    .select({ artifact: harnessSkillArtifacts, file: harnessSkillArtifactFiles })
    .from(harnessSkillArtifacts)
    .leftJoin(
      harnessSkillArtifactFiles,
      eq(harnessSkillArtifactFiles.artifactId, harnessSkillArtifacts.id),
    )
    .where(
      and(
        eq(harnessSkillArtifacts.organizationId, input.organizationId),
        inArray(harnessSkillArtifacts.artifactHash, input.artifactHashes),
      ),
    )
    .orderBy(
      asc(harnessSkillArtifacts.id),
      asc(harnessSkillArtifactFiles.path),
    );
  const artifacts = Array.from(
    new Map(rows.map(({ artifact }) => [artifact.id, artifact])).values(),
  );
  const files = rows.flatMap(({ file }) => file === null ? [] : [file]);
  return { artifacts, files };
}

/** Persist an imported artifact batch in one statement. Validation remains above the DB tier. */
export async function persistHarnessSkillArtifactRows(
  db: Db,
  input: {
    organizationId: string;
    actorId: string;
    artifactRows: SQL[];
    fileRows: SQL[];
  },
): Promise<void> {
  await db.execute(sql`
    WITH imported_artifact (
      artifact_hash, name, description, source_kind, source_owner,
      source_repository, source_path, source_commit_sha, local_path, local_content_sha256
    ) AS (VALUES ${sql.join(input.artifactRows, sql`, `)}),
    inserted_artifact AS (
      INSERT INTO harness_skill_artifacts (
        organization_id, artifact_hash, name, description, source_kind, source_owner,
        source_repository, source_path, source_commit_sha, local_path,
        local_content_sha256, created_by_id
      )
      SELECT ${input.organizationId}, artifact_hash, name, description, source_kind,
        source_owner, source_repository, source_path, source_commit_sha, local_path,
        local_content_sha256, ${input.actorId}
      FROM imported_artifact
      ON CONFLICT (organization_id, artifact_hash) DO NOTHING
      RETURNING id, artifact_hash
    ), stored_artifact AS (
      SELECT inserted.id, inserted.artifact_hash FROM inserted_artifact inserted
      UNION ALL
      SELECT artifact.id, artifact.artifact_hash
      FROM harness_skill_artifacts artifact
      INNER JOIN imported_artifact imported ON imported.artifact_hash = artifact.artifact_hash
      WHERE artifact.organization_id = ${input.organizationId}
        AND NOT EXISTS (
          SELECT 1 FROM inserted_artifact inserted
          WHERE inserted.artifact_hash = artifact.artifact_hash
        )
    ), imported_file (artifact_hash, path, mode, size_bytes, sha256, content_base64)
      AS (VALUES ${sql.join(input.fileRows, sql`, `)})
    INSERT INTO harness_skill_artifact_files (
      artifact_id, path, mode, size_bytes, sha256, content_base64
    )
    SELECT stored.id, file.path, file.mode, file.size_bytes, file.sha256, file.content_base64
    FROM imported_file file
    INNER JOIN stored_artifact stored ON stored.artifact_hash = file.artifact_hash
    ON CONFLICT (artifact_id, path) DO NOTHING
  `);
}

/**
 * The policy layer uses this narrow collection of named statements instead of
 * receiving a database capability. Keeping the connection here makes the
 * production callers connected without turning it into a generic DB facade.
 */
export function createHarnessProfileRepository(db: Db) {
  return {
    insertSystemProfile(input: Parameters<typeof insertSystemHarnessProfile>[1]) {
      return insertSystemHarnessProfile(db, input);
    },
    getSystemProfile(profileId: string) {
      return getSystemHarnessProfile(db, profileId);
    },
    getLatestSystemVersion(profileId: string) {
      return getLatestSystemHarnessProfileVersion(db, profileId);
    },
    getSystemVersion(input: Parameters<typeof getSystemHarnessProfileVersion>[1]) {
      return getSystemHarnessProfileVersion(db, input);
    },
    insertSystemVersion(input: Parameters<typeof insertSystemHarnessProfileVersion>[1]) {
      return insertSystemHarnessProfileVersion(db, input);
    },
    updateSystemProfile(input: Parameters<typeof updateSystemHarnessProfile>[1]) {
      return updateSystemHarnessProfile(db, input);
    },
    listProfiles(input: Parameters<typeof listHarnessProfiles>[1]) {
      return listHarnessProfiles(db, input);
    },
    getProfile(input: Parameters<typeof getHarnessProfile>[1]) {
      return getHarnessProfile(db, input);
    },
    getVersionRaw(input: Parameters<typeof getHarnessProfileVersionRaw>[1]) {
      return getHarnessProfileVersionRaw(db, input);
    },
    listVersions(input: Parameters<typeof listHarnessProfileVersions>[1]) {
      return listHarnessProfileVersions(db, input);
    },
    getVersion(input: Parameters<typeof getHarnessProfileVersion>[1]) {
      return getHarnessProfileVersion(db, input);
    },
    getArtifactsByHashes(input: Parameters<typeof getHarnessSkillArtifactsByHashes>[1]) {
      return getHarnessSkillArtifactsByHashes(db, input);
    },
    resolveVersionRaw(input: Parameters<typeof resolveHarnessProfileVersionRaw>[1]) {
      return resolveHarnessProfileVersionRaw(db, input);
    },
    getArtifactEnvelope(input: Parameters<typeof getHarnessSkillArtifactEnvelopeByHashes>[1]) {
      return getHarnessSkillArtifactEnvelopeByHashes(db, input);
    },
    getArtifactByHash(input: { organizationId: string; artifactHash: string }) {
      return getHarnessSkillArtifactsByHashes(db, {
        organizationId: input.organizationId,
        artifactHashes: [input.artifactHash],
      }).then(([artifact]) => artifact ?? null);
    },
    persistArtifactRows(input: Parameters<typeof persistHarnessSkillArtifactRows>[1]) {
      return persistHarnessSkillArtifactRows(db, input);
    },
    getLatestVersion(profileId: string) {
      return getLatestHarnessProfileVersionNumber(db, profileId);
    },
    publishPrepared(input: Parameters<typeof publishHarnessProfilePrepared>[1]) {
      return publishHarnessProfilePrepared(db, input);
    },
    replaceDraftPrepared(input: Parameters<typeof replaceHarnessProfileDraftPrepared>[1]) {
      return replaceHarnessProfileDraftPrepared(db, input);
    },
    insertProfile(input: Parameters<typeof insertHarnessProfile>[1]) {
      return insertHarnessProfile(db, input);
    },
    replaceDraft(input: Parameters<typeof replaceHarnessProfileDraft>[1]) {
      return replaceHarnessProfileDraft(db, input);
    },
    archiveProfile(input: Parameters<typeof archiveHarnessProfileRaw>[1]) {
      return archiveHarnessProfileRaw(db, input);
    },
    restoreArchivedProfile(input: Parameters<typeof restoreArchivedHarnessProfileRaw>[1]) {
      return restoreArchivedHarnessProfileRaw(db, input);
    },
    hasProfileVersions(profileId: string) {
      return hasHarnessProfileVersions(db, profileId);
    },
    deleteUnpublishedProfile(input: Parameters<typeof deleteUnpublishedHarnessProfile>[1]) {
      return deleteUnpublishedHarnessProfile(db, input);
    },
  };
}

export function createConnectedHarnessProfileRepository() {
  return createHarnessProfileRepository(getDb());
}
