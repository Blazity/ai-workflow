import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  max,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type {
  BuiltinHarnessProfileId,
  HarnessProfileDetailResponse,
  HarnessProfileDraftManifest,
  HarnessProfileDto,
  HarnessProfileManifest,
  HarnessProfileManifestV1,
  HarnessProfileReference,
  HarnessProfileResolvedVersion,
  HarnessProfileSkillSourceDto,
  HarnessProfileUsageDto,
  HarnessProfileVersionDto,
  HarnessResolvedSkillArtifact,
  HarnessSkillSource,
} from "@shared/contracts";
import { BUILTIN_HARNESS_PROFILE_MANIFESTS } from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  type HarnessProvider,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  harnessProfiles,
  harnessProfileVersions,
  harnessProfileVersionSkills,
  harnessSkillArtifactFiles,
  harnessSkillArtifacts,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import {
  canManageHarnessProfiles,
  type DashboardRole,
} from "../lib/auth/roles.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";
import {
  compileHarnessProfileManifest,
  HarnessProfileManifestError,
  hashHarnessProfileManifest,
  parseHarnessProfileDraftManifest,
  stableJson,
} from "./manifest.js";
import {
  HarnessCapabilityCatalogError,
  requireFreshHarnessCapabilities,
  upgradeHarnessDraftToHistoricalV2,
} from "./capability-catalog.js";
import {
  HarnessSkillArtifactIntegrityError,
  verifyHarnessSkillArtifact,
} from "./skill-artifact.js";

const VERSION_LIST_LIMIT = 50;
const SYSTEM_ACTOR_ID = "system:harness-profiles";
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type SystemHarnessProfileCatalog = Readonly<
  Record<BuiltinHarnessProfileId, Readonly<HarnessProfileManifestV1>>
>;

export interface HarnessProfileActor {
  organizationId: string;
  role: DashboardRole;
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
      throw new HarnessSkillArtifactIntegrityError(
        "Skill artifact claims the local source kind but is missing columns " +
          "that harness_skill_artifacts_source_shape_check should have required.",
      );
    }
    return { path: localPath, contentSha256: localContentSha256 };
  }
  if (artifact.sourceKind !== "github") {
    throw new HarnessSkillArtifactIntegrityError(
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
    throw new HarnessSkillArtifactIntegrityError(
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

function requireManageRole(role: DashboardRole): void {
  if (!canManageHarnessProfiles(role)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
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

function validateSlug(value: unknown): string {
  if (
    typeof value !== "string" ||
    !SLUG_PATTERN.test(value) ||
    value.length > 64
  ) {
    throw new HarnessProfileStoreError(
      400,
      "Slug must be 1-64 lowercase letters, numbers, or hyphens",
    );
  }
  return value;
}

function assertPositiveRevision(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new HarnessProfileStoreError(400, "Invalid draft revision");
  }
}

function normalizeDraft(value: unknown): HarnessProfileDraftManifest {
  try {
    return parseHarnessProfileDraftManifest(value);
  } catch (error) {
    if (error instanceof HarnessProfileManifestError) {
      throw new HarnessProfileStoreError(400, error.message, {
        issues: error.issues,
      });
    }
    throw error;
  }
}

function draftFromManifest(
  manifest: HarnessProfileManifest,
): HarnessProfileDraftManifest {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...draft
  } = manifest;
  return normalizeDraft(draft);
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

function collectProfileReferenceVersions(
  value: unknown,
  profileId: string,
  versions: Set<number>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectProfileReferenceVersions(item, profileId, versions);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    record.profileId === profileId &&
    typeof record.version === "number" &&
    Number.isSafeInteger(record.version) &&
    record.version > 0
  ) {
    versions.add(record.version);
  }
  for (const nested of Object.values(record)) {
    collectProfileReferenceVersions(nested, profileId, versions);
  }
}

export async function listHarnessProfileUsage(
  db: Db,
  profileId: string,
): Promise<HarnessProfileUsageDto[]> {
  const definitions = await db
    .select({
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      deployedVersion: workflowDefinitions.deployedVersion,
    })
    .from(workflowDefinitions)
    .where(isNull(workflowDefinitions.archivedAt))
    .orderBy(asc(workflowDefinitions.name));
  if (definitions.length === 0) return [];
  const rows = await db
    .select({
      definitionId: workflowDefinitionVersions.definitionId,
      version: workflowDefinitionVersions.version,
      definition: workflowDefinitionVersions.definition,
    })
    .from(workflowDefinitionVersions)
    .where(
      inArray(
        workflowDefinitionVersions.definitionId,
        definitions.map((definition) => definition.id),
      ),
    )
    .orderBy(
      asc(workflowDefinitionVersions.definitionId),
      desc(workflowDefinitionVersions.version),
    );
  const rowsByDefinition = new Map<number, typeof rows>();
  for (const row of rows) {
    const current = rowsByDefinition.get(row.definitionId) ?? [];
    current.push(row);
    rowsByDefinition.set(row.definitionId, current);
  }
  const usage: HarnessProfileUsageDto[] = [];
  for (const definition of definitions) {
    const definitionRows = rowsByDefinition.get(definition.id) ?? [];
    const head = definitionRows[0];
    const deployed = definition.deployedVersion
      ? definitionRows.find(
          (candidate) => candidate.version === definition.deployedVersion,
        )
      : undefined;
    const relevant = [head, deployed].filter(
      (
        candidate,
        index,
        candidates,
      ): candidate is NonNullable<typeof candidate> =>
        Boolean(candidate) &&
        candidates.findIndex(
          (other) => other?.version === candidate?.version,
        ) === index,
    );
    const referencedVersions = new Set<number>();
    for (const candidate of relevant) {
      collectProfileReferenceVersions(
        candidate.definition,
        profileId,
        referencedVersions,
      );
    }
    if (referencedVersions.size > 0) {
      usage.push({
        definitionId: definition.id,
        name: definition.name,
        versions: [...referencedVersions].sort((left, right) => left - right),
        deployed: Boolean(
          deployed &&
            (() => {
              const versions = new Set<number>();
              collectProfileReferenceVersions(
                deployed.definition,
                profileId,
                versions,
              );
              return versions.size > 0;
            })(),
        ),
      });
    }
  }
  return usage;
}

export async function ensureSystemHarnessProfiles(
  db: Db,
  catalog: SystemHarnessProfileCatalog = BUILTIN_HARNESS_PROFILE_MANIFESTS,
): Promise<void> {
  for (const [catalogProfileId, codeOwned] of Object.entries(catalog)) {
    if (
      codeOwned.profileId !== catalogProfileId ||
      codeOwned.system !== true ||
      !Number.isInteger(codeOwned.version) ||
      codeOwned.version < 1
    ) {
      throw new HarnessProfileStoreError(
        500,
        `Invalid code-owned Harness Profile catalog entry ${catalogProfileId}`,
      );
    }
    const initialDraft = draftFromManifest(codeOwned);
    await db
      .insert(harnessProfiles)
      .values({
        id: codeOwned.profileId,
        organizationId: null,
        slug: codeOwned.slug,
        draftManifest: initialDraft,
        draftRevision: 1,
        publishedVersion: null,
        system: true,
        readOnly: true,
        createdById: SYSTEM_ACTOR_ID,
        updatedById: SYSTEM_ACTOR_ID,
      })
      .onConflictDoNothing({ target: harnessProfiles.id });

    const [profile] = await db
      .select()
      .from(harnessProfiles)
      .where(
        and(
          eq(harnessProfiles.id, codeOwned.profileId),
          isNull(harnessProfiles.organizationId),
          eq(harnessProfiles.system, true),
          eq(harnessProfiles.readOnly, true),
        ),
      )
      .limit(1);
    if (!profile) {
      throw new HarnessProfileStoreError(
        409,
        `Profile ID ${codeOwned.profileId} is already used by a non-system profile`,
      );
    }

    const [latest] = await db
      .select()
      .from(harnessProfileVersions)
      .where(eq(harnessProfileVersions.profileId, profile.id))
      .orderBy(desc(harnessProfileVersions.version))
      .limit(1);

    // The manifest version is the code-owned catalog revision. A process with
    // an older catalog must never append or republish its stale content after a
    // newer process has seeded this stable profile ID.
    if (latest && latest.version > codeOwned.version) {
      continue;
    }

    const candidate = compileHarnessProfileManifest({
      profileId: profile.id,
      version: codeOwned.version,
      slug: codeOwned.slug,
      system: true,
      draft: initialDraft,
    });
    const candidateHash = hashHarnessProfileManifest(candidate);
    let [published] = await db
      .select()
      .from(harnessProfileVersions)
      .where(
        and(
          eq(harnessProfileVersions.profileId, profile.id),
          eq(harnessProfileVersions.version, codeOwned.version),
        ),
      )
      .limit(1);
    if (!published) {
      const inserted = await db
        .insert(harnessProfileVersions)
        .values({
          profileId: profile.id,
          version: codeOwned.version,
          manifest: candidate,
          manifestHash: candidateHash,
          createdById: SYSTEM_ACTOR_ID,
        })
        .onConflictDoNothing()
        .returning();
      published = inserted[0];
      if (!published) {
        [published] = await db
          .select()
          .from(harnessProfileVersions)
          .where(
            and(
              eq(harnessProfileVersions.profileId, profile.id),
              eq(harnessProfileVersions.version, codeOwned.version),
            ),
          )
          .limit(1);
      }
    }
    if (
      !published ||
      published.manifestHash !== candidateHash ||
      !isDeepStrictEqual(published.manifest, candidate)
    ) {
      throw new HarnessProfileStoreError(
        409,
        `System Harness Profile ${profile.id} catalog version ${codeOwned.version} does not match its stored immutable version`,
      );
    }

    if (
      profile.publishedVersion !== published.version ||
      profile.slug !== codeOwned.slug ||
      !isDeepStrictEqual(profile.draftManifest, initialDraft)
    ) {
      await db
        .update(harnessProfiles)
        .set({
          slug: codeOwned.slug,
          draftManifest: initialDraft,
          draftRevision: sql<number>`CASE
            WHEN ${harnessProfiles.draftManifest} IS DISTINCT FROM ${JSON.stringify(initialDraft)}::jsonb
              THEN ${harnessProfiles.draftRevision} + 1
            ELSE ${harnessProfiles.draftRevision}
          END`,
          publishedVersion: published.version,
          updatedAt: new Date(),
          updatedById: SYSTEM_ACTOR_ID,
        })
        .where(
          and(
            eq(harnessProfiles.id, profile.id),
            isNull(harnessProfiles.organizationId),
            eq(harnessProfiles.system, true),
            eq(harnessProfiles.readOnly, true),
            or(
              isNull(harnessProfiles.publishedVersion),
              lt(harnessProfiles.publishedVersion, published.version),
              eq(harnessProfiles.publishedVersion, published.version),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(harnessProfileVersions)
                .where(
                  and(
                    eq(harnessProfileVersions.profileId, profile.id),
                    gt(harnessProfileVersions.version, published.version),
                  ),
                ),
            ),
          ),
        );
    }
  }
}

export async function listHarnessProfiles(
  db: Db,
  input: { organizationId: string; includeArchived?: boolean },
): Promise<HarnessProfileDto[]> {
  await ensureSystemHarnessProfiles(db);
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
  await ensureSystemHarnessProfiles(db);
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

export async function getHarnessProfile(
  db: Db,
  input: {
    organizationId: string;
    profileId: string;
  },
): Promise<ProfileSelect | null> {
  await ensureSystemHarnessProfiles(db);
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
async function readDraftSkillSources(
  db: Db,
  input: {
    organizationId: string;
    draft: HarnessProfileDraftManifest;
  },
): Promise<HarnessProfileSkillSourceDto[]> {
  const artifactHashes = input.draft.skills.map((skill) => skill.artifactHash);
  if (artifactHashes.length === 0) return [];
  const rows = await db
    .select()
    .from(harnessSkillArtifacts)
    .where(
      and(
        eq(harnessSkillArtifacts.organizationId, input.organizationId),
        inArray(harnessSkillArtifacts.artifactHash, artifactHashes),
      ),
    );
  return rows.map((row) => ({
    artifactHash: row.artifactHash,
    source: readHarnessSkillArtifactSource(row),
  }));
}

export async function getHarnessProfileDetail(
  db: Db,
  input: {
    organizationId: string;
    profileId: string;
    actorRole: DashboardRole;
    requestedVersion?: number;
  },
): Promise<HarnessProfileDetailResponse | null> {
  const profile = await getHarnessProfile(db, input);
  if (!profile) return null;
  const recentVersions = await listHarnessProfileVersions(db, input);
  const requestedVersion =
    input.requestedVersion === undefined ||
    recentVersions.some((version) => version.version === input.requestedVersion)
      ? null
      : await getHarnessProfileVersion(db, {
          organizationId: input.organizationId,
          profileId: input.profileId,
          version: input.requestedVersion,
        });
  const versions = requestedVersion
    ? [...recentVersions, requestedVersion]
    : recentVersions;
  const usage = await listHarnessProfileUsage(db, profile.id);
  const canManageProfile =
    !profile.readOnly && canManageHarnessProfiles(input.actorRole);
  return {
    profile: mapProfile(profile),
    skillSources: await readDraftSkillSources(db, {
      organizationId: input.organizationId,
      draft: profile.draftManifest,
    }),
    published:
      versions.find((version) => version.version === profile.publishedVersion) ??
      null,
    versions,
    canManageProfile,
    canDeleteProfile:
      canManageProfile &&
      !profile.system &&
      profile.publishedVersion === null &&
      versions.length === 0 &&
      usage.length === 0,
    usage,
  };
}

export async function createHarnessProfile(
  db: Db,
  input: {
    slug: unknown;
    draft: unknown;
    actor: HarnessProfileActor;
  },
): Promise<HarnessProfileDto> {
  requireManageRole(input.actor.role);
  const slug = validateSlug(input.slug);
  const draft = normalizeDraft(input.draft);
  try {
    const [row] = await db
      .insert(harnessProfiles)
      .values({
        id: randomUUID(),
        organizationId: input.actor.organizationId,
        slug,
        draftManifest: draft,
        createdById: input.actor.id,
        updatedById: input.actor.id,
      })
      .returning();
    return mapProfile(row!);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HarnessProfileStoreError(409, "Slug already in use");
    }
    throw error;
  }
}

export async function updateHarnessProfileDraft(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    draft: unknown;
    actor: HarnessProfileActor;
  },
): Promise<HarnessProfileDto> {
  requireManageRole(input.actor.role);
  assertPositiveRevision(input.expectedRevision);
  const draft = normalizeDraft(input.draft);
  const [updated] = await db
    .update(harnessProfiles)
    .set({
      draftManifest: draft,
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
  if (updated) return mapProfile(updated);
  return throwWriteMiss(db, input);
}

export async function publishHarnessProfile(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
): Promise<{
  profile: HarnessProfileDto;
  version: HarnessProfileVersionDto;
  changed: boolean;
}> {
  requireManageRole(input.actor.role);
  assertPositiveRevision(input.expectedRevision);
  const profile = await getWritableProfileForRevision(db, input);
  const draft = normalizeDraft(profile.draftManifest);
  if (draft.schemaVersion === 2) {
    let capabilities;
    try {
      capabilities = await requireFreshHarnessCapabilities(db, {
        organizationId: input.actor.organizationId,
        provider: draft.harness.provider,
        cliVersion: draft.harness.cliVersion,
      });
    } catch (error) {
      if (error instanceof HarnessCapabilityCatalogError) {
        throw new HarnessProfileStoreError(error.statusCode, error.message);
      }
      throw error;
    }
    if (capabilities.catalogHash !== draft.model.catalogHash) {
      throw new HarnessProfileStoreError(
        409,
        "Harness capabilities changed. Review the current model settings before publishing.",
      );
    }
    const model = capabilities.models.find(
      (candidate) => candidate.id === draft.model.id,
    );
    if (
      !model ||
      stableJson(model) !== stableJson(draft.model.capability)
    ) {
      throw new HarnessProfileStoreError(
        409,
        "The selected model capability snapshot is no longer current.",
      );
    }
  }
  const artifacts = await getHarnessSkillArtifactsByHashes(db, {
    organizationId: input.actor.organizationId,
    artifactHashes: draft.skills.map((skill) => skill.artifactHash),
  });
  if (artifacts.length !== draft.skills.length) {
    throw new HarnessProfileStoreError(
      400,
      "Profile references an unknown skill artifact",
    );
  }
  const artifactByHash = new Map(
    artifacts.map((artifact) => [artifact.artifactHash, artifact]),
  );
  const canonicalNames = new Set<string>();
  for (const skill of draft.skills) {
    const artifact = artifactByHash.get(skill.artifactHash)!;
    if (skill.name !== artifact.name) {
      throw new HarnessProfileStoreError(
        400,
        `Profile skill "${skill.name}" does not match the pinned artifact name "${artifact.name}"`,
      );
    }
    if (canonicalNames.has(artifact.name)) {
      throw new HarnessProfileStoreError(
        400,
        `Profile contains duplicate canonical skill name "${artifact.name}"`,
      );
    }
    canonicalNames.add(artifact.name);
  }

  if (profile.publishedVersion !== null) {
    const [current] = await db
      .select()
      .from(harnessProfileVersions)
      .where(
        and(
          eq(harnessProfileVersions.profileId, profile.id),
          eq(harnessProfileVersions.version, profile.publishedVersion),
        ),
      )
      .limit(1);
    if (current && isDeepStrictEqual(draftFromManifest(current.manifest), draft)) {
      return {
        profile: mapProfile(profile),
        version: mapVersion(current),
        changed: false,
      };
    }
  }

  const [latest] = await db
    .select({ version: max(harnessProfileVersions.version) })
    .from(harnessProfileVersions)
    .where(eq(harnessProfileVersions.profileId, profile.id));
  const version = (latest?.version ?? 0) + 1;
  const manifest = compileHarnessProfileManifest({
    profileId: profile.id,
    version,
    slug: profile.slug,
    system: false,
    draft,
  });
  const manifestHash = hashHarnessProfileManifest(manifest);
  const skillRows = draft.skills.map((skill, position) => {
    const artifact = artifactByHash.get(skill.artifactHash)!;
    return sql`(${artifact.id}::integer, ${skill.name}::text, ${position}::integer)`;
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
  let selected: { profileId: string; version: number } | undefined;
  try {
    const result = await db.execute(sql`
      WITH claimed_profile AS (
        UPDATE harness_profiles
        SET published_version = ${version},
            draft_restored_from_version = NULL,
            updated_at = now(),
            updated_by_id = ${input.actor.id}
        WHERE id = ${profile.id}
          AND organization_id = ${input.actor.organizationId}
          AND system = false
          AND read_only = false
          AND archived_at IS NULL
          AND draft_revision = ${input.expectedRevision}
          AND published_version IS NOT DISTINCT FROM ${profile.publishedVersion}
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
          ${version},
          ${JSON.stringify(manifest)}::jsonb,
          ${manifestHash},
          ${input.actor.id},
          ${profile.draftRestoredFromVersion}
        FROM claimed_profile claimed
        RETURNING profile_id, version
      )
      ${insertedSkillsCte}
      SELECT inserted.profile_id AS "profileId", inserted.version
      FROM inserted_version inserted
      JOIN claimed_profile claimed ON claimed.id = inserted.profile_id
      ${skillBarrier}
    `);
    selected = rawRows<{ profileId: string; version: number }>(result)[0];
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HarnessProfileStoreError(
        409,
        "Profile changed while it was being published",
      );
    }
    throw error;
  }
  if (!selected) {
    return throwWriteMiss(db, input);
  }
  const [[updated], [inserted]] = await Promise.all([
    db
      .select()
      .from(harnessProfiles)
      .where(
        and(
          eq(harnessProfiles.id, selected.profileId),
          eq(harnessProfiles.publishedVersion, selected.version),
        ),
      )
      .limit(1),
    db
      .select()
      .from(harnessProfileVersions)
      .where(
        and(
          eq(harnessProfileVersions.profileId, selected.profileId),
          eq(harnessProfileVersions.version, selected.version),
        ),
      )
      .limit(1),
  ]);
  if (!updated || !inserted) {
    throw new HarnessProfileStoreError(
      500,
      "Published Harness Profile version was not readable",
    );
  }
  return {
    profile: mapProfile(updated),
    version: mapVersion(inserted),
    changed: true,
  };
}

export async function restoreHarnessProfileVersion(
  db: Db,
  input: {
    profileId: string;
    version: number;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
): Promise<HarnessProfileDto> {
  requireManageRole(input.actor.role);
  assertPositiveRevision(input.expectedRevision);
  assertPositiveRevision(input.version);
  const profile = await getWritableProfileForRevision(db, input);
  const [source] = await db
    .select()
    .from(harnessProfileVersions)
    .where(
      and(
        eq(harnessProfileVersions.profileId, profile.id),
        eq(harnessProfileVersions.version, input.version),
      ),
    )
    .limit(1);
  if (!source) {
    throw new HarnessProfileStoreError(404, "Profile version not found");
  }
  let restoredDraft = draftFromManifest(source.manifest);
  if (restoredDraft.schemaVersion === 1) {
    restoredDraft = upgradeHarnessDraftToHistoricalV2(restoredDraft);
  }
  const [updated] = await db
    .update(harnessProfiles)
    .set({
      draftManifest: restoredDraft,
      draftRevision: sql`${harnessProfiles.draftRevision} + 1`,
      draftRestoredFromVersion: source.version,
      updatedAt: new Date(),
      updatedById: input.actor.id,
    })
    .where(
      and(
        writableProfileCondition({
          organizationId: input.actor.organizationId,
          profileId: profile.id,
        }),
        eq(harnessProfiles.draftRevision, input.expectedRevision),
        isNull(harnessProfiles.archivedAt),
      ),
    )
    .returning();
  if (!updated) {
    throw new HarnessProfileStoreError(
      409,
      "Profile changed while it was being restored",
    );
  }
  return mapProfile(updated);
}

export async function forkHarnessProfile(
  db: Db,
  input: {
    profileId: string;
    slug: unknown;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
): Promise<HarnessProfileDto> {
  requireManageRole(input.actor.role);
  assertPositiveRevision(input.expectedRevision);
  const source = await getHarnessProfile(db, {
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
  });
  if (!source) {
    throw new HarnessProfileStoreError(404, "Profile not found");
  }
  if (source.draftRevision !== input.expectedRevision) {
    throw new HarnessProfileStoreError(409, "Profile draft revision conflict");
  }
  let draft = normalizeDraft(source.draftManifest);
  if (draft.schemaVersion === 1) {
    draft = upgradeHarnessDraftToHistoricalV2(draft);
  }
  return createHarnessProfile(db, {
    slug: input.slug,
    draft,
    actor: input.actor,
  });
}

export async function archiveHarnessProfile(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
): Promise<HarnessProfileDto> {
  requireManageRole(input.actor.role);
  assertPositiveRevision(input.expectedRevision);
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
  if (updated) return mapProfile(updated);
  return throwWriteMiss(db, input);
}

export async function restoreArchivedHarnessProfile(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
): Promise<HarnessProfileDto> {
  requireManageRole(input.actor.role);
  assertPositiveRevision(input.expectedRevision);
  try {
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
    if (updated) return mapProfile(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HarnessProfileStoreError(
        409,
        "Another active profile already uses this slug",
      );
    }
    throw error;
  }
  return throwWriteMiss(db, input);
}

export async function deleteHarnessProfile(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
): Promise<void> {
  requireManageRole(input.actor.role);
  assertPositiveRevision(input.expectedRevision);
  const profile = await getHarnessProfile(db, {
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
  });
  if (!profile) {
    throw new HarnessProfileStoreError(404, "Profile not found");
  }
  if (
    profile.organizationId !== input.actor.organizationId ||
    profile.system ||
    profile.readOnly
  ) {
    throw new HarnessProfileStoreError(403, "Profile is read-only");
  }
  if (profile.draftRevision !== input.expectedRevision) {
    throw new HarnessProfileStoreError(409, "Profile draft revision conflict");
  }
  const [version] = await db
    .select({ version: harnessProfileVersions.version })
    .from(harnessProfileVersions)
    .where(eq(harnessProfileVersions.profileId, profile.id))
    .limit(1);
  const usage = await listHarnessProfileUsage(db, profile.id);
  if (profile.publishedVersion !== null || version || usage.length > 0) {
    throw new HarnessProfileStoreError(
      409,
      "Published or workflow-pinned profiles must be archived",
    );
  }
  const [deleted] = await db
    .delete(harnessProfiles)
    .where(
      and(
        eq(harnessProfiles.id, profile.id),
        eq(harnessProfiles.organizationId, input.actor.organizationId),
        eq(harnessProfiles.draftRevision, input.expectedRevision),
        eq(harnessProfiles.system, false),
        eq(harnessProfiles.readOnly, false),
        isNull(harnessProfiles.publishedVersion),
      ),
    )
    .returning({ id: harnessProfiles.id });
  if (!deleted) {
    throw new HarnessProfileStoreError(
      409,
      "Profile changed while it was being deleted",
    );
  }
}

export async function replaceHarnessProfileSkillArtifact(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    previousArtifactHash: string;
    nextArtifactHash: string;
    actor: HarnessProfileActor;
  },
): Promise<HarnessProfileDto> {
  requireManageRole(input.actor.role);
  assertPositiveRevision(input.expectedRevision);
  const profile = await getWritableProfileForRevision(db, input);
  const draft = normalizeDraft(profile.draftManifest);
  const index = draft.skills.findIndex(
    (skill) => skill.artifactHash === input.previousArtifactHash,
  );
  if (index < 0) {
    throw new HarnessProfileStoreError(
      400,
      "Profile does not reference the skill artifact",
    );
  }
  if (input.previousArtifactHash === input.nextArtifactHash) {
    return mapProfile(profile);
  }
  const [nextArtifact] = await getHarnessSkillArtifactsByHashes(db, {
    organizationId: input.actor.organizationId,
    artifactHashes: [input.nextArtifactHash],
  });
  if (!nextArtifact) {
    throw new HarnessProfileStoreError(404, "Replacement skill artifact not found");
  }
  const nextDraft = structuredClone(draft);
  nextDraft.skills[index] = {
    artifactHash: nextArtifact.artifactHash,
    name: nextArtifact.name,
  };
  return updateHarnessProfileDraft(db, {
    profileId: input.profileId,
    expectedRevision: input.expectedRevision,
    draft: nextDraft,
    actor: input.actor,
  });
}

export async function resolveHarnessProfileVersion(
  db: Db,
  input: {
    organizationId: string;
    profileId: string;
    version: number;
  },
): Promise<HarnessProfileResolvedVersion | null> {
  await ensureSystemHarnessProfiles(db);
  if (!Number.isInteger(input.version) || input.version < 1) return null;
  const [row] = await db
    .select({
      profile: harnessProfiles,
      version: harnessProfileVersions,
    })
    .from(harnessProfileVersions)
    .innerJoin(
      harnessProfiles,
      eq(harnessProfiles.id, harnessProfileVersions.profileId),
    )
    .where(
      and(
        eq(harnessProfileVersions.profileId, input.profileId),
        eq(harnessProfileVersions.version, input.version),
        visibleProfileCondition(input.organizationId),
      ),
    )
    .limit(1);
  if (!row) return null;
  let skillArtifacts: HarnessResolvedSkillArtifact[];
  try {
    skillArtifacts = await getVersionSkillArtifacts(db, {
      organizationId: input.organizationId,
      profileId: row.profile.id,
      version: row.version.version,
    });
  } catch (error) {
    if (error instanceof HarnessSkillArtifactIntegrityError) return null;
    throw error;
  }
  return {
    manifest: structuredClone(row.version.manifest),
    manifestHash: row.version.manifestHash,
    skillArtifacts,
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
  try {
    await loadAndVerifyHarnessSkillArtifacts(db, artifacts);
  } catch (error) {
    if (!(error instanceof HarnessSkillArtifactIntegrityError)) throw error;
    throw new HarnessProfileStoreError(
      409,
      "Stored skill artifact failed integrity verification",
    );
  }
  return artifacts;
}

async function getVersionSkillArtifacts(
  db: Db,
  input: {
    organizationId: string;
    profileId: string;
    version: number;
  },
): Promise<HarnessResolvedSkillArtifact[]> {
  const relations = await db
    .select({
      artifact: harnessSkillArtifacts,
      skillName: harnessProfileVersionSkills.skillName,
      position: harnessProfileVersionSkills.position,
    })
    .from(harnessProfileVersionSkills)
    .innerJoin(
      harnessSkillArtifacts,
      eq(harnessSkillArtifacts.id, harnessProfileVersionSkills.artifactId),
    )
    .where(
      and(
        eq(harnessProfileVersionSkills.profileId, input.profileId),
        eq(harnessProfileVersionSkills.profileVersion, input.version),
        eq(harnessSkillArtifacts.organizationId, input.organizationId),
      ),
    )
    .orderBy(asc(harnessProfileVersionSkills.position));
  if (relations.length === 0) return [];
  const resolved = await loadAndVerifyHarnessSkillArtifacts(
    db,
    relations.map(({ artifact }) => artifact),
  );
  const resolvedByHash = new Map(
    resolved.map((artifact) => [artifact.artifactHash, artifact]),
  );
  const canonicalNames = new Set<string>();
  for (const { artifact, skillName } of relations) {
    if (artifact.name !== skillName) {
      throw new HarnessSkillArtifactIntegrityError(
        "Published profile skill name does not match its canonical artifact.",
      );
    }
    if (canonicalNames.has(artifact.name)) {
      throw new HarnessSkillArtifactIntegrityError(
        "Published profile contains a duplicate canonical skill name.",
      );
    }
    canonicalNames.add(artifact.name);
  }
  return relations.map(({ artifact }) => {
    const candidate = resolvedByHash.get(artifact.artifactHash);
    if (!candidate) {
      throw new HarnessSkillArtifactIntegrityError(
        "Published profile references an unavailable skill artifact.",
      );
    }
    return candidate;
  });
}

async function loadAndVerifyHarnessSkillArtifacts(
  db: Db,
  artifacts: Array<typeof harnessSkillArtifacts.$inferSelect>,
): Promise<HarnessResolvedSkillArtifact[]> {
  if (artifacts.length === 0) return [];
  const files = await db
    .select()
    .from(harnessSkillArtifactFiles)
    .where(
      inArray(
        harnessSkillArtifactFiles.artifactId,
        artifacts.map((artifact) => artifact.id),
      ),
    )
    .orderBy(
      asc(harnessSkillArtifactFiles.artifactId),
      asc(harnessSkillArtifactFiles.path),
    );
  const filesByArtifact = new Map<number, typeof files>();
  for (const file of files) {
    const current = filesByArtifact.get(file.artifactId) ?? [];
    current.push(file);
    filesByArtifact.set(file.artifactId, current);
  }
  return artifacts.map((artifact) => {
    const resolved: HarnessResolvedSkillArtifact = {
      artifactHash: artifact.artifactHash,
      organizationId: artifact.organizationId,
      name: artifact.name,
      description: artifact.description,
      source: readHarnessSkillArtifactSource(artifact),
      files: (filesByArtifact.get(artifact.id) ?? []).map((file) => ({
        path: file.path,
        mode: file.mode,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        contentBase64: file.contentBase64,
      })),
      createdAt: artifact.createdAt.toISOString(),
      createdById: artifact.createdById,
    };
    verifyHarnessSkillArtifact(resolved);
    return resolved;
  });
}

async function getWritableProfileForRevision(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
): Promise<ProfileSelect> {
  const [profile] = await db
    .select()
    .from(harnessProfiles)
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
    .limit(1);
  if (profile) return profile;
  return throwWriteMiss(db, input);
}

async function throwWriteMiss(
  db: Db,
  input: {
    profileId: string;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
): Promise<never> {
  const visible = await getHarnessProfile(db, {
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
  });
  if (!visible) throw new HarnessProfileStoreError(404, "Profile not found");
  if (visible.readOnly) {
    throw new DashboardAuthError(403, "System profiles are read-only");
  }
  if (visible.archivedAt !== null) {
    throw new HarnessProfileStoreError(409, "Profile is archived");
  }
  throw new HarnessProfileStoreError(409, "Profile draft revision conflict");
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    cause?: { code?: string };
    message?: string;
  };
  return (
    candidate.code === "23505" ||
    candidate.cause?.code === "23505" ||
    candidate.message?.includes("duplicate key") === true
  );
}
