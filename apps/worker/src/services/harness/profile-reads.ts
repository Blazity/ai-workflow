/**
 * What the dashboard may read of the harness profiles an organization owns.
 *
 * The stores below take a connection and answer about rows; this binds the
 * connection and decides what a dashboard read means. The detail read returns
 * null for a profile the actor may not see, which is the same answer as one
 * that does not exist: the caller turns both into the one 404.
 */
import {
  canManageHarnessProfiles,
  type DashboardRole,
  type HarnessProfileDetailResponse,
  type HarnessProfileUsageDto,
} from "@shared/contracts";
import {
  createHarnessProfileRepository,
  createConnectedHarnessProfileRepository,
  getConnectedCurrentSystemHarnessProfileReference,
  mapHarnessProfileRow,
  readHarnessSkillArtifactSource,
  type HarnessProfileActor,
} from "../../db/repositories/harness-profiles.js";
import { listConnectedHarnessProfileUsage } from "../../db/harness-profile-usage-store.js";
import type { Db } from "../../db/types.js";
import {
  ensureConnectedSystemHarnessProfiles,
  ensureSystemHarnessProfilesOnDb,
} from "../../harness-profiles/system-seed.js";
import { defaultBuiltinHarnessProfile } from "@shared/harness";

/** The actor fields every profile operation needs, as the route knows them. */
export type { HarnessProfileActor };

/** The current built-in profile, ensuring its immutable system rows exist first. */
export async function currentSystemHarnessProfileReference(
) {
  await ensureConnectedSystemHarnessProfiles();
  return getConnectedCurrentSystemHarnessProfileReference(
    defaultBuiltinHarnessProfile().harness.provider,
  );
}

/** The organization's profiles, archived ones only when asked for. */
export async function listHarnessProfilesForOrganization(input: {
  organizationId: string;
  includeArchived: boolean;
}) {
  const repository = createConnectedHarnessProfileRepository();
  await ensureConnectedSystemHarnessProfiles();
  return repository.listProfiles(input);
}

/**
 * One profile as a workflow author pins it on an agent block.
 *
 * Read off the PUBLISHED version, because that is what a pin runs: the draft
 * may name another model entirely and runs nothing until it is published. A
 * profile nobody published yet is still listed, from its draft, with `pin`
 * null, so an author learns it exists and why it cannot be chosen.
 */
export interface HarnessProfilePinOption {
  profileId: string;
  slug: string;
  name: string;
  /** Shipped with the deployment rather than authored in this organization. */
  system: boolean;
  provider: string;
  model: string;
  publishedVersion: number | null;
  /** Exactly what a node's `configuration.harnessProfile` takes, or null when
   *  nothing is published to pin. */
  pin: { profileId: string; version: number } | null;
}

async function pinOptionsFrom(
  repository: ReturnType<typeof createHarnessProfileRepository>,
  organizationId: string,
): Promise<HarnessProfilePinOption[]> {
  const profiles = await repository.listProfiles({ organizationId, includeArchived: false });
  return Promise.all(
    profiles.map(async (profile): Promise<HarnessProfilePinOption> => {
      const published =
        profile.publishedVersion === null
          ? null
          : await repository.getVersion({
              organizationId,
              profileId: profile.id,
              version: profile.publishedVersion,
            });
      const manifest = published?.manifest ?? profile.draft;
      return {
        profileId: profile.id,
        slug: profile.slug,
        name: manifest.displayName,
        system: profile.system,
        provider: manifest.harness.provider,
        model: manifest.model.id,
        publishedVersion: published ? published.version : null,
        pin: published ? { profileId: profile.id, version: published.version } : null,
      };
    }),
  );
}

/** The profiles an organization can pin, archived ones left out. */
export async function listHarnessProfilePinOptions(
  organizationId: string,
): Promise<HarnessProfilePinOption[]> {
  await ensureConnectedSystemHarnessProfiles();
  return pinOptionsFrom(createConnectedHarnessProfileRepository(), organizationId);
}

/** The same, over a caller's own database handle. */
export async function listHarnessProfilePinOptionsFromDb(
  db: Db,
  organizationId: string,
): Promise<HarnessProfilePinOption[]> {
  await ensureSystemHarnessProfilesOnDb(db);
  return pinOptionsFrom(createHarnessProfileRepository(db), organizationId);
}

/** One profile with its versions and usage, or null when it names nothing. */
export async function readHarnessProfileDetail(input: {
  organizationId: string;
  profileId: string;
  actorRole: DashboardRole;
  requestedVersion: number | undefined;
}) {
  await ensureConnectedSystemHarnessProfiles();
  const repository = createConnectedHarnessProfileRepository();
  return assembleHarnessProfileDetail(repository, input, {
    canManageProfiles: canManageHarnessProfiles(input.actorRole),
    usage: await listConnectedHarnessProfileUsage(input.profileId),
  });
}

export function readHarnessProfileDetailFromDb(
  db: Db,
  input: {
    organizationId: string;
    profileId: string;
    canManageProfiles: boolean;
    requestedVersion?: number;
    usage: HarnessProfileUsageDto[];
  },
) {
  return assembleHarnessProfileDetail(createHarnessProfileRepository(db), input, input);
}

async function assembleHarnessProfileDetail(
  repository: ReturnType<typeof createHarnessProfileRepository>,
  input: { organizationId: string; profileId: string; requestedVersion?: number },
  policy: { canManageProfiles: boolean; usage: HarnessProfileUsageDto[] },
): Promise<HarnessProfileDetailResponse | null> {
  const profile = await repository.getProfile(input);
  if (!profile) return null;
  const recentVersions = await repository.listVersions(input);
  const requested = input.requestedVersion === undefined ||
    recentVersions.some((version) => version.version === input.requestedVersion)
    ? null
    : await repository.getVersion({ ...input, version: input.requestedVersion });
  const versions = requested ? [...recentVersions, requested] : recentVersions;
  const { usage } = policy;
  const artifactHashes = profile.draftManifest.skills.map((skill) => skill.artifactHash);
  const artifacts = artifactHashes.length === 0
    ? []
    : await repository.getArtifactsByHashes({
        organizationId: input.organizationId,
        artifactHashes,
      });
  const canManageProfile = !profile.readOnly && policy.canManageProfiles;
  const detail: HarnessProfileDetailResponse = {
    profile: mapHarnessProfileRow(profile),
    skillSources: artifacts.map((artifact) => ({
      artifactHash: artifact.artifactHash,
      source: readHarnessSkillArtifactSource(artifact),
    })),
    published: versions.find((version) => version.version === profile.publishedVersion) ?? null,
    versions,
    canManageProfile,
    canDeleteProfile: canManageProfile && !profile.system &&
      profile.publishedVersion === null && versions.length === 0 && usage.length === 0,
    usage,
  };
  return detail;
}
