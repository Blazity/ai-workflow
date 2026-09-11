import { isDeepStrictEqual } from "node:util";
import type {
  BuiltinHarnessProfileId,
  HarnessProfileDraftManifest,
  HarnessProfileManifest,
  HarnessProfileManifestV1,
} from "@shared/contracts";
import {
  createConnectedHarnessProfileRepository,
  createHarnessProfileRepository,
  HarnessProfileStoreError,
} from "../db/repositories/harness-profiles.js";
import { BUILTIN_HARNESS_PROFILE_MANIFESTS, compileHarnessProfileManifest, hashHarnessProfileManifest, parseHarnessProfileDraftManifest } from "./manifest.js";

const SYSTEM_ACTOR_ID = "system:harness-profiles";

export type SystemHarnessProfileCatalog = Readonly<
  Record<BuiltinHarnessProfileId, Readonly<HarnessProfileManifestV1>>
>;

export interface SystemHarnessProfileSeedEnvelope {
  profileId: BuiltinHarnessProfileId;
  slug: string;
  version: number;
  draft: HarnessProfileDraftManifest;
  manifest: HarnessProfileManifest;
  manifestHash: string;
}

type SystemHarnessProfileRepository = Pick<
  ReturnType<typeof createHarnessProfileRepository>,
  | "insertSystemProfile"
  | "getSystemProfile"
  | "getLatestSystemVersion"
  | "getSystemVersion"
  | "insertSystemVersion"
  | "updateSystemProfile"
>;

export function systemHarnessProfileSeedEnvelopes(
  catalog: SystemHarnessProfileCatalog = BUILTIN_HARNESS_PROFILE_MANIFESTS,
): SystemHarnessProfileSeedEnvelope[] {
  return Object.entries(catalog).map(([profileId, manifest]) => {
    const { profileId: _profileId, version: _version, slug: _slug, system: _system, ...draft } = manifest;
    const normalizedDraft = parseHarnessProfileDraftManifest(draft);
    const compiled = compileHarnessProfileManifest({ profileId: manifest.profileId, version: manifest.version, slug: manifest.slug, system: true, draft: normalizedDraft });
    return { profileId: profileId as SystemHarnessProfileSeedEnvelope["profileId"], slug: manifest.slug, version: manifest.version, draft: normalizedDraft, manifest: compiled, manifestHash: hashHarnessProfileManifest(compiled) };
  });
}

/**
 * Applies the code-owned catalog while repositories perform only the named
 * row statements. Catalog validation, immutable-content comparison, and the
 * decision to advance a system profile belong to the harness-profile policy
 * layer rather than the DB tier.
 */
export async function ensureSystemHarnessProfiles(
  repository: SystemHarnessProfileRepository,
  catalog: readonly SystemHarnessProfileSeedEnvelope[],
): Promise<void> {
  for (const codeOwned of catalog) {
    if (!Number.isInteger(codeOwned.version) || codeOwned.version < 1) {
      throw new HarnessProfileStoreError(
          500,
          `Invalid code-owned Harness Profile catalog entry ${codeOwned.profileId}`,
        );
    }

    await repository.insertSystemProfile({
      profileId: codeOwned.profileId,
      slug: codeOwned.slug,
      draft: codeOwned.draft,
      actorId: SYSTEM_ACTOR_ID,
    });
    const profile = await repository.getSystemProfile(codeOwned.profileId);
    if (!profile) {
      throw new HarnessProfileStoreError(
          409,
          `Profile ID ${codeOwned.profileId} is already used by a non-system profile`,
        );
    }

    const latest = await repository.getLatestSystemVersion(profile.id);
    if (latest && latest.version > codeOwned.version) continue;

    let published = await repository.getSystemVersion({
      profileId: profile.id,
      version: codeOwned.version,
    });
    if (!published) {
      published = await repository.insertSystemVersion({
        profileId: profile.id,
        version: codeOwned.version,
        manifest: codeOwned.manifest,
        manifestHash: codeOwned.manifestHash,
        actorId: SYSTEM_ACTOR_ID,
      });
      if (!published) {
        published = await repository.getSystemVersion({
          profileId: profile.id,
          version: codeOwned.version,
        });
      }
    }
    if (
      !published ||
      published.manifestHash !== codeOwned.manifestHash ||
      !isDeepStrictEqual(published.manifest, codeOwned.manifest)
    ) {
      throw new HarnessProfileStoreError(
          409,
          `System Harness Profile ${profile.id} catalog version ${codeOwned.version} does not match its stored immutable version`,
        );
    }
    if (
      profile.publishedVersion !== published.version ||
      profile.slug !== codeOwned.slug ||
      !isDeepStrictEqual(profile.draftManifest, codeOwned.draft)
    ) {
      await repository.updateSystemProfile({
        profileId: profile.id,
        slug: codeOwned.slug,
        draft: codeOwned.draft,
        publishedVersion: published.version,
        actorId: SYSTEM_ACTOR_ID,
      });
    }
  }
}

export function ensureConnectedSystemHarnessProfiles(
  catalog = systemHarnessProfileSeedEnvelopes(),
): Promise<void> {
  return ensureSystemHarnessProfiles(
    createConnectedHarnessProfileRepository(),
    catalog,
  );
}

export function ensureSystemHarnessProfilesOnDb(
  db: Parameters<typeof createHarnessProfileRepository>[0],
  catalog = systemHarnessProfileSeedEnvelopes(),
): Promise<void> {
  return ensureSystemHarnessProfiles(createHarnessProfileRepository(db), catalog);
}
