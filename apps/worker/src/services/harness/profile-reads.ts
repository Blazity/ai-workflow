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
import { ensureConnectedSystemHarnessProfiles } from "../../harness-profiles/system-seed.js";

/** The actor fields every profile operation needs, as the route knows them. */
export type { HarnessProfileActor };

/** The current built-in profile, ensuring its immutable system rows exist first. */
export async function currentSystemHarnessProfileReference(
  provider: Parameters<typeof getConnectedCurrentSystemHarnessProfileReference>[0],
) {
  await ensureConnectedSystemHarnessProfiles();
  return getConnectedCurrentSystemHarnessProfileReference(provider);
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
